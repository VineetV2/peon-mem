import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper, no type declarations
import { isClientAbort, isServerFault, isStaleSession } from "../scripts/lib/stl-classify.mjs";

describe("stl-classify: client aborts are not server faults", () => {
  const abort = { type: "response_out", path: "/events", status: 500, error: "aborted", durationMs: 1 };
  const abortWord = { type: "response_out", path: "/events", status: 500, error: "request aborted by client" };
  const realFault = { type: "response_out", path: "/events", status: 500, error: "TypeError: cannot read x" };
  const ise500NoErr = { type: "response_out", path: "/context", status: 500 };
  const ok201 = { type: "response_out", path: "/events", status: 201, durationMs: 4 };

  it("flags an error:'aborted' 500 as a client abort", () => {
    expect(isClientAbort(abort)).toBe(true);
    expect(isClientAbort(abortWord)).toBe(true);
  });

  it("does not treat a real 5xx or a <500 as a client abort", () => {
    expect(isClientAbort(realFault)).toBe(false);
    expect(isClientAbort(ise500NoErr)).toBe(false);
    expect(isClientAbort(ok201)).toBe(false);
    expect(isClientAbort(null)).toBe(false);
  });

  it("isServerFault excludes client aborts but keeps genuine 5xx", () => {
    // The bug: aborts were counted as serious recording-path 5xx.
    expect(isServerFault(abort)).toBe(false);
    expect(isServerFault(abortWord)).toBe(false);
    expect(isServerFault(realFault)).toBe(true);
    expect(isServerFault(ise500NoErr)).toBe(true);
    expect(isServerFault(ok201)).toBe(false);
  });

  it("a batch of 110 aborts + 2 real faults yields exactly 2 server faults", () => {
    const batch = [
      ...Array.from({ length: 110 }, () => ({ type: "response_out", path: "/events", status: 500, error: "aborted" })),
      { type: "response_out", path: "/events", status: 503, error: "upstream down" },
      { type: "response_out", path: "/sessions", status: 500, error: "boom" },
    ];
    expect(batch.filter(isServerFault).length).toBe(2);
  });
});

describe("stl-classify: self-healed stale-session 500s are not server faults", () => {
  const stale = { type: "response_out", path: "/messages", status: 500, error: "Unknown Peon session: e3161752-f8b6-4321-9f3a-6e2b3927830e", durationMs: 1 };
  const staleEvent = { type: "response_out", path: "/events", status: 500, error: "Unknown Peon session: abc" };
  const realFault = { type: "response_out", path: "/messages", status: 500, error: "TypeError: cannot read x" };
  const abort = { type: "response_out", path: "/events", status: 500, error: "aborted" };
  const ok201 = { type: "response_out", path: "/messages", status: 201 };

  it("flags an 'Unknown Peon session' 500 as a stale session (client self-heals)", () => {
    expect(isStaleSession(stale)).toBe(true);
    expect(isStaleSession(staleEvent)).toBe(true);
  });

  it("does not treat a real 5xx, an abort, a 201, or null as a stale session", () => {
    expect(isStaleSession(realFault)).toBe(false);
    expect(isStaleSession(abort)).toBe(false);
    expect(isStaleSession(ok201)).toBe(false);
    expect(isStaleSession(null)).toBe(false);
  });

  it("isServerFault excludes stale-session rejections but keeps genuine 5xx", () => {
    // The bug: recovered 'Unknown Peon session' 500s were counted as serious recording-path 5xx.
    expect(isServerFault(stale)).toBe(false);
    expect(isServerFault(staleEvent)).toBe(false);
    expect(isServerFault(realFault)).toBe(true);
  });

  it("a batch of 5 stale-session 500s + 1 real fault yields exactly 1 server fault", () => {
    const batch = [
      ...Array.from({ length: 5 }, () => ({ type: "response_out", path: "/messages", status: 500, error: "Unknown Peon session: x" })),
      { type: "response_out", path: "/messages", status: 500, error: "genuine crash" },
    ];
    expect(batch.filter(isServerFault).length).toBe(1);
  });
});
