import { Levels, LoggerFactory } from "../../../lib/core/index.js";

/**
 * LoggerFactory caching and labeling tests.
 *
 * The factory caches loggers so that repeated calls for the same category
 * return the same instance. Previously, the `label` argument was honored
 * only when the level was `debug`; below that the label was silently dropped
 * and a category-only cached logger was returned. These tests pin down the
 * new behavior: labels participate in the cache key at every level, and a
 * labeled logger emits with that label at every level.
 */

describe("Core LoggerFactory", () => {
  let factory: LoggerFactory;

  beforeEach(() => {
    factory = new LoggerFactory();
    // Default level is `log`. Suppress console output so test runs stay quiet.
    factory.builtinEnabled = false;
  });

  it("returns the same logger for repeated category-only calls", () => {
    const a = factory.getLogger("cat");
    const b = factory.getLogger("cat");
    expect(a).toBe(b);
  });

  it("returns the same logger for repeated (category, label) calls", () => {
    const a = factory.getLogger("cat", "x");
    const b = factory.getLogger("cat", "x");
    expect(a).toBe(b);
  });

  it("returns distinct loggers for the same category with different labels", () => {
    const x = factory.getLogger("cat", "x");
    const y = factory.getLogger("cat", "y");
    expect(x).not.toBe(y);
  });

  it("returns distinct loggers for category-only vs labeled call", () => {
    const plain = factory.getLogger("cat");
    const labeled = factory.getLogger("cat", "x");
    expect(plain).not.toBe(labeled);
  });

  it("emits the label via the connector at non-debug levels", () => {
    const calls: Array<{ level: string; category: string; label: string | undefined; content: unknown }> = [];
    factory.connector = (level, category, label, content) => calls.push({ level, category, label, content });
    // Default level (log) — explicitly assert we are not at debug.
    expect(factory.level).not.toBe(Levels.debug);

    factory.getLogger("cat", "wss://example.com:5061/ws").log("hello");

    expect(calls.length).toBe(1);
    expect(calls[0].category).toBe("cat");
    expect(calls[0].label).toBe("wss://example.com:5061/ws");
    expect(calls[0].content).toBe("hello");
  });

  it("emits no label via the connector when none was supplied", () => {
    const calls: Array<{ label: string | undefined }> = [];
    factory.connector = (_level, _category, label, _content) => calls.push({ label });

    factory.getLogger("cat").warn("oops");

    expect(calls.length).toBe(1);
    expect(calls[0].label).toBeUndefined();
  });
});
