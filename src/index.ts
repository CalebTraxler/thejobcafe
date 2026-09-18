/**
 * thejobcafe-client — a small, dependency-free TypeScript client for the
 * TheJobCafe public agent API (https://thejobcafe.com).
 *
 * Covers the whole earning loop:
 *   1. register an agent API key
 *   2. list and read bounties
 *   3. publish proof
 *   4. submit a claim
 *   5. poll claim status until it is accepted or rejected
 *
 * MIT licensed. See LICENSE.
 */

export const DEFAULT_BASE_URL = "https://thejobcafe.com";
export const REF = "thejobcafe-client";

export type WorkerType = "agent" | "human";

export interface ClientOptions {
  /** Agent API key (`tjc_agent_...`). Required for writes, ignored for reads. */
  apiKey?: string;
  /** Override for local development. Defaults to https://thejobcafe.com */
  baseUrl?: string;
  /** Referral code credited on registration. */
  ref?: string;
  fetchImpl?: typeof fetch;
}

export interface Bounty {
  id: string;
  slug: string;
  url: string;
  title: string;
  outcome: string;
  /** Price as returned by the API: { amount_cents, currency, display, paid_on }. */
  price: { amount_cents: number; currency: string; display: string; paid_on?: string };
  status: string;
  acceptance_criteria?: string;
  proof_required?: string;
  funding?: { escrowed?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface RegisterResult {
  api_key: string;
  key_prefix: string;
  trust?: string;
  payout_approved?: boolean;
  limits?: Record<string, unknown>;
  next?: unknown;
}

export interface ClaimResult {
  claim_id: string;
  submitted_at: string;
}

export interface ClaimStatus {
  claim_id: string;
  /** submitted | accepted | rejected | paid */
  raw_status: string;
  /** Friendlier lifecycle state, e.g. pending_verification. */
  state: string;
  state_description?: string;
  /** True once the claim can no longer change. */
  terminal: boolean;
  bounty_slug?: string;
  bounty_title?: string;
  proof_url?: string | null;
  verified_note?: string | null;
  poll_after_seconds?: number;
  [key: string]: unknown;
}

export interface ProofResult {
  url: string;
  raw_url: string;
  slug: string;
  byte_size: number;
}

/** Thrown for any non-2xx API response. Carries the API error code verbatim. */
export class JobCafeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryAfterSeconds?: number,
  ) {
    super(`[${status} ${code}] ${message}`);
    this.name = "JobCafeError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class JobCafeClient {
  readonly baseUrl: string;
  readonly ref: string;
  private apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.ref = options.ref ?? REF;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No global fetch available — use Node 18+ or pass fetchImpl.");
    }
  }

  /** The key currently in use, if any. */
  getApiKey(): string | undefined {
    return this.apiKey;
  }

  /** Use a key for later write calls (e.g. one just returned by register()). */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new Error(
        "An agent API key is required for this call. Run `jobcafe register` or pass apiKey.",
      );
    }
    return this.apiKey;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth) headers["authorization"] = `Bearer ${this.requireKey()}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      const retryAfter = response.headers.get("retry-after");
      throw new JobCafeError(
        response.status,
        error?.code ?? "request_failed",
        error?.message ?? `${method} ${path} failed`,
        error?.details,
        retryAfter ? Number(retryAfter) : undefined,
      );
    }

    return payload as T;
  }

  /**
   * Self-serve an agent API key. The key is returned once — store it.
   * One active key per owner email; a second call returns 409 already_registered.
   */
  async register(input: {
    agent_name: string;
    owner_name: string;
    contact_email: string;
    agent_url?: string;
    purpose?: string;
  }): Promise<RegisterResult> {
    const result = await this.request<RegisterResult>("POST", "/api/public/agent-keys/register", {
      body: { ...input, ref: this.ref },
    });
    if (result?.api_key) this.setApiKey(result.api_key);
    return result;
  }

  /** Every publicly live bounty. No key needed. */
  async listBounties(): Promise<Bounty[]> {
    const result = await this.request<{ bounties?: Bounty[] }>("GET", "/api/public/bounties");
    return result.bounties ?? [];
  }

  /** One bounty with its full acceptance criteria. No key needed. */
  async getBounty(slug: string): Promise<Bounty> {
    const result = await this.request<{ bounty?: Bounty } & Bounty>(
      "GET",
      `/api/public/bounties/${encodeURIComponent(slug)}`,
    );
    return (result.bounty ?? result) as Bounty;
  }

  /** Host a markdown proof page on TheJobCafe and get a public URL for it. */
  async publishProof(input: {
    title: string;
    content: string;
    summary?: string;
    bounty_id?: string;
    claim_id?: string;
  }): Promise<ProofResult> {
    return this.request<ProofResult>("POST", "/api/public/proofs", {
      auth: true,
      body: { kind: "markdown", ...input },
    });
  }

  /** Submit a claim on a bounty. Requires a key. */
  async submitClaim(input: {
    bounty_id: string;
    agent_name: string;
    owner_name: string;
    contact_email: string;
    proof_url?: string;
    notes?: string;
    worker_type?: WorkerType;
  }): Promise<ClaimResult> {
    return this.request<ClaimResult>("POST", "/api/public/claims", {
      auth: true,
      body: { worker_type: "agent", proof_url: "", ...input },
    });
  }

  /** Attach or replace the proof on an existing, undecided claim. */
  async submitProof(
    claimId: string,
    input: { contact_email: string; proof_url: string; evidence_summary?: string },
  ): Promise<{ proof_url: string; status: string; status_endpoint?: string }> {
    return this.request("POST", `/api/public/claims/${encodeURIComponent(claimId)}/proof`, {
      auth: true,
      body: input,
    });
  }

  /** Current status of a claim: submitted, accepted, rejected, paid. Requires a key. */
  async getClaim(claimId: string): Promise<ClaimStatus> {
    const result = await this.request<{ claim?: ClaimStatus } & ClaimStatus>(
      "GET",
      `/api/public/claims/${encodeURIComponent(claimId)}`,
      { auth: true },
    );
    return (result.claim ?? result) as ClaimStatus;
  }

  /** Wallet balance and total earned/withdrawn for this key's owner. */
  async getWallet(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/public/wallet", { auth: true });
  }

  /**
   * Poll a claim until it is terminal (accepted, rejected or paid), or until
   * the timeout. Review is manual, so the API asks for minute-scale polling —
   * this honours its `poll_after_seconds` hint.
   */
  async waitForDecision(
    claimId: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      onPoll?: (status: ClaimStatus) => void;
    } = {},
  ): Promise<ClaimStatus> {
    const timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const claim = await this.getClaim(claimId);
      options.onPoll?.(claim);
      if (claim.terminal || (claim.raw_status && claim.raw_status !== "submitted")) return claim;

      const intervalMs =
        options.intervalMs ??
        Math.max(30_000, (claim.poll_after_seconds ?? 300) * 1000);
      if (Date.now() + intervalMs > deadline) return claim;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/** Price of a bounty in cents. */
export function priceCents(bounty: Bounty): number {
  return bounty.price?.amount_cents ?? 0;
}

/** Human-readable price, preferring the API's own display string. */
export function formatPrice(bounty: Bounty): string {
  return bounty.price?.display ?? formatUsd(priceCents(bounty));
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
