import { Registerer, RegistererState, UserAgent, UserAgentOptions } from "../../../lib/api/index.js";
import { Logger } from "../../../lib/core/index.js";
import { EmitterSpy, makeEmitterSpy } from "../../support/api/emitter-spy.js";
import { connectUserFake, makeUserFake, UserFake } from "../../support/api/user-fake.js";
import { TransportFake } from "../../support/api/transport-fake.js";
import { soon } from "../../support/api/utils.js";

/**
 * Multi-transport Outbound Registration Integration Tests (RFC 5626 limited)
 */

describe("API Registration Outbound (multi-transport)", () => {
  /**
   * A transport constructor that appends every created instance to `created`.
   * Instances created before `start()` (the constructor placeholder) can be
   * discarded by calling `created.splice(0)` before invoking `start()`.
   */
  function makeTrackingTransportConstructor(
    created: TransportFake[]
  ): new (logger: Logger, options: unknown) => TransportFake {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return class TrackingTransport extends TransportFake {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(logger: Logger, _options: any) {
        super(logger);
        created.push(this);
      }
    };
  }

  describe("Alice creates a UserAgent with resolveServers returning two addresses", () => {
    let alice: UserAgent;
    let registrar1: UserFake;
    let registrar2: UserFake;
    let aliceTransports: TransportFake[];

    beforeEach(async () => {
      jasmine.clock().install();

      aliceTransports = [];
      const transportConstructor = makeTrackingTransportConstructor(aliceTransports);

      const aliceOptions: UserAgentOptions = {
        uri: UserAgent.makeURI("sip:alice@example.com"),
        transportConstructor,
        transportOptions: { server: "wss://sip.example.com:5061/ws" },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        resolveServers: async (_server: string) => ["wss://192.0.2.1:5061/ws", "wss://192.0.2.2:5061/ws"]
      };

      // Construct UA without starting — this creates the placeholder transport.
      alice = new UserAgent(aliceOptions);

      // Spin up two registrars.
      registrar1 = await makeUserFake(undefined, "example.com", "Registrar1");
      registrar2 = await makeUserFake(undefined, "example.com", "Registrar2");

      // Discard the placeholder transport created in the constructor so that
      // after start(), aliceTransports[0] and [1] are the two real transports.
      aliceTransports.splice(0);

      await alice.start();

      // Wire each real transport to its registrar.
      aliceTransports[0].addPeer(registrar1.transport);
      registrar1.transport.addPeer(aliceTransports[0]);
      aliceTransports[1].addPeer(registrar2.transport);
      registrar2.transport.addPeer(aliceTransports[1]);

      await soon();
    });

    afterEach(async () => {
      if (alice) {
        await alice.stop().catch(() => { /* ignore */ });
      }
      await registrar1.userAgent.stop().catch(() => { /* ignore */ });
      await registrar2.userAgent.stop().catch(() => { /* ignore */ });
      jasmine.clock().uninstall();
    });

    it("two transport connections are established", () => {
      expect(aliceTransports.length).toBe(2);
      expect(aliceTransports[0].isConnected()).toBeTrue();
      expect(aliceTransports[1].isConnected()).toBeTrue();
    });

    it("two UserAgentCores are created", () => {
      expect(alice.userAgentCores.length).toBe(2);
    });

    it("isConnected() returns true when at least one transport is connected", () => {
      expect(alice.isConnected()).toBeTrue();
    });

    describe("REGISTER routing and RFC 5626 headers", () => {
      it("each registerer sends REGISTER on its own transport with correct reg-id and shared instance-id", async () => {
        const transport1SendSpy = spyOn(aliceTransports[0], "send").and.callThrough();
        const transport2SendSpy = spyOn(aliceTransports[1], "send").and.callThrough();

        const sharedInstanceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = Math.floor(Math.random() * 16);
          const v = c === "x" ? r : (r % 4) + 8;
          return v.toString(16);
        });

        let reg1ContactHeader: string | undefined;
        let reg2ContactHeader: string | undefined;
        let reg1SupportedHeader: string | undefined;
        let reg2SupportedHeader: string | undefined;

        // Promises that resolve once each registrar has accepted a REGISTER.
        let resolveReg1: () => void;
        let resolveReg2: () => void;
        const reg1Done = new Promise<void>((r) => (resolveReg1 = r));
        const reg2Done = new Promise<void>((r) => (resolveReg2 = r));

        registrar1.userAgent.delegate = {
          onRegisterRequest: (request): void => {
            reg1ContactHeader = request.message.getHeader("contact");
            reg1SupportedHeader = request.message.getHeader("supported");
            const contact = request.message.parseHeader("contact");
            request.accept({ extraHeaders: [`Contact: ${contact}`], statusCode: 200 });
            resolveReg1();
          }
        };
        registrar2.userAgent.delegate = {
          onRegisterRequest: (request): void => {
            reg2ContactHeader = request.message.getHeader("contact");
            reg2SupportedHeader = request.message.getHeader("supported");
            const contact = request.message.parseHeader("contact");
            request.accept({ extraHeaders: [`Contact: ${contact}`], statusCode: 200 });
            resolveReg2();
          }
        };

        const reg1 = new Registerer(alice, {
          regId: 1,
          instanceId: sharedInstanceId,
          userAgentCore: alice.userAgentCores[0]
        });
        const reg2 = new Registerer(alice, {
          regId: 2,
          instanceId: sharedInstanceId,
          userAgentCore: alice.userAgentCores[1]
        });

        const reg1StateSpy = makeEmitterSpy(reg1.stateChange, alice.getLogger("Alice"));
        const reg2StateSpy = makeEmitterSpy(reg2.stateChange, alice.getLogger("Alice"));

        reg1.register();
        reg2.register();

        // Advance the fake clock to flush timers and microtasks.
        await soon();
        await reg1Done;
        await reg2Done;
        await soon();

        // Each REGISTER went out on the correct transport.
        expect(transport1SendSpy).toHaveBeenCalledWith(jasmine.stringMatching(/^REGISTER/));
        expect(transport2SendSpy).toHaveBeenCalledWith(jasmine.stringMatching(/^REGISTER/));

        // reg-id values are distinct.
        expect(reg1ContactHeader).toMatch(/reg-id=1/);
        expect(reg2ContactHeader).toMatch(/reg-id=2/);

        // Both carry the same +sip.instance UUID.
        const extractUuid = (h: string): string | undefined => {
          const m = h.match(/\+sip\.instance="<urn:uuid:([^"]+)>"/);
          return m ? m[1] : undefined;
        };
        expect(extractUuid(reg1ContactHeader ?? "")).toBeTruthy();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(extractUuid(reg1ContactHeader!)).toEqual(extractUuid(reg2ContactHeader!));

        // Both include Supported: outbound per RFC 5626 §4.2.
        expect(reg1SupportedHeader).toContain("outbound");
        expect(reg2SupportedHeader).toContain("outbound");

        // Both registerers transition to Registered.
        expect(reg1StateSpy).toHaveBeenCalledTimes(1);
        expect(reg1StateSpy.calls.argsFor(0)).toEqual([RegistererState.Registered]);
        expect(reg2StateSpy).toHaveBeenCalledTimes(1);
        expect(reg2StateSpy.calls.argsFor(0)).toEqual([RegistererState.Registered]);

        await reg1.dispose().catch(() => { /* ignore */ });
        await reg2.dispose().catch(() => { /* ignore */ });
      });
    });
  });

  describe("backward compatibility — no resolveServers (single transport)", () => {
    let alice: UserFake;
    let registrar: UserFake;

    beforeEach(async () => {
      jasmine.clock().install();
      alice = await makeUserFake("alice", "example.com", "Alice");
      registrar = await makeUserFake(undefined, "example.com", "Registrar");
      connectUserFake(alice, registrar);
      await soon();
    });

    afterEach(async () => {
      await alice.userAgent.stop().catch(() => { /* ignore */ });
      await registrar.userAgent.stop().catch(() => { /* ignore */ });
      jasmine.clock().uninstall();
    });

    it("only one core is created", () => {
      expect(alice.userAgent.userAgentCores.length).toBe(1);
    });

    it("userAgentCore getter returns the same object as userAgentCores[0]", () => {
      expect(alice.userAgent.userAgentCore).toBe(alice.userAgent.userAgentCores[0]);
    });

    it("transport getter returns the same object as the single transport", () => {
      expect(alice.userAgent.transport).toBe(alice.transport);
    });

    it("register() succeeds as before", async () => {
      const registerer = new Registerer(alice.userAgent);
      const stateSpy = makeEmitterSpy(registerer.stateChange, alice.userAgent.getLogger("Alice"));

      registrar.userAgent.delegate = {
        onRegisterRequest: (request): void => {
          const contact = request.message.parseHeader("contact");
          request.accept({ extraHeaders: [`Contact: ${contact}`], statusCode: 200 });
        }
      };

      registerer.register();
      await alice.transport.waitReceived();

      expect(stateSpy).toHaveBeenCalledTimes(1);
      expect(stateSpy.calls.argsFor(0)).toEqual([RegistererState.Registered]);

      await registerer.dispose();
    });

    it("a Registerer with regId includes Supported: outbound", async () => {
      let supportedHeader: string | undefined;

      registrar.userAgent.delegate = {
        onRegisterRequest: (request): void => {
          supportedHeader = request.message.getHeader("supported");
          const contact = request.message.parseHeader("contact");
          request.accept({ extraHeaders: [`Contact: ${contact}`], statusCode: 200 });
        }
      };

      const registererWithRegId = new Registerer(alice.userAgent, { regId: 1 });
      registererWithRegId.register();
      await alice.transport.waitReceived();

      expect(supportedHeader).toContain("outbound");

      await registererWithRegId.dispose();
    });

    it("a plain Registerer (no regId) does not add a duplicate Supported header", async () => {
      let supportedHeaders: Array<string> = [];

      registrar.userAgent.delegate = {
        onRegisterRequest: (request): void => {
          supportedHeaders = request.message.getHeaders("supported");
          const contact = request.message.parseHeader("contact");
          request.accept({ extraHeaders: [`Contact: ${contact}`], statusCode: 200 });
        }
      };

      const registerer = new Registerer(alice.userAgent);
      registerer.register();
      await alice.transport.waitReceived();

      // At most one Supported header; no duplicate injected by Registerer.
      expect(supportedHeaders.length).toBeLessThanOrEqual(1);

      await registerer.dispose();
    });
  });
});
