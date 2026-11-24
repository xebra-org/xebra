import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { irisFetch } = vi.hoisted(() => ({
  irisFetch: vi.fn(),
}));

vi.mock("../../../lib/server/iris", () => ({
  irisBaseUrl: () => "https://iris.example.test",
  irisFetch,
}));

const { POST } = await import("./route");

const makeNonce = (fill: string) => `0x${fill.repeat(64)}`;

function postNonce(nonce: string) {
  return POST(
    new Request("http://localhost/api/reattest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    }),
  );
}

describe("POST /api/reattest", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    irisFetch.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps Circle 400 not-expired-yet to 422 with friendly copy and logs Circle's body", async () => {
    const circleRaw = JSON.stringify({ message: "Attestation has not expired yet for this nonce" });
    irisFetch.mockResolvedValue(new Response(circleRaw, { status: 400 }));

    const res = await postNonce(makeNonce("1"));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      status: "failed",
      reason: "This attestation has not expired, so it does not need renewing.",
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("Attestation has not expired yet for this nonce");
  });

  it("maps Circle 400 already-reattested to 409 with friendly copy and logs Circle's body", async () => {
    const circleRaw = JSON.stringify({ message: "Message was already re-attested" });
    irisFetch.mockResolvedValue(new Response(circleRaw, { status: 400 }));

    const res = await postNonce(makeNonce("2"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "It was already renewed; look it up again.",
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("Message was already re-attested");
  });

  it("does not forward arbitrary Circle 4xx text to the browser", async () => {
    const circleRaw = JSON.stringify({ message: "internal upstream parser detail xyz" });
    irisFetch.mockResolvedValue(new Response(circleRaw, { status: 400 }));

    const res = await postNonce(makeNonce("3"));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      status: "failed",
      reason: "Circle could not renew this attestation.",
    });
    expect(JSON.stringify(json)).not.toContain("internal upstream parser detail xyz");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("internal upstream parser detail xyz");
  });

  it("maps Circle 404 to 404 without leaking Circle text", async () => {
    irisFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "iris db row missing" }), { status: 404 }),
    );

    const res = await postNonce(makeNonce("4"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "Circle has no attestation for that nonce.",
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("maps Circle 5xx to 502 and logs Circle's body", async () => {
    irisFetch.mockResolvedValue(new Response("upstream gateway exploded", { status: 503 }));

    const res = await postNonce(makeNonce("5"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "Circle returned 503",
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("upstream gateway exploded");
  });

  it("returns 200 requested when Circle accepts re-attestation", async () => {
    irisFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await postNonce(makeNonce("6"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "requested" });
    expect(errSpy).not.toHaveBeenCalled();
  });
});
