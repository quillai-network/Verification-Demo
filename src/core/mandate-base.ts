// src/mandate.ts
import canonicalize from "canonicalize";
import {
  keccak256, toUtf8Bytes, verifyMessage, verifyTypedData,
} from "ethers";
import type { HDNodeWallet, TypedDataDomain } from "ethers";
import { ulid } from "ulid";
import type {
  Bytes32, Hex, MandateInit, MandateJSON, MandateBase,
  MandateSignatures, Signature, SigAlg, VerifyAllResult, VerifyResult
} from "../../types/mandate";

/** Minimal runtime validator interface (works with Zod or custom). */
export interface PrimitiveValidator<T = unknown> {
  /** validate or throw; return typed value */
  parse(payload: unknown): T;
  /** optional JSON Schema export */
  toJSONSchema?: () => unknown;
}

export type PrimitiveKind = `${string}@${number}`;
type PrimitiveDef<T> = { kind: PrimitiveKind; validator: PrimitiveValidator<T>; describe?: string };

function deepClone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
function canonicalizeForHash<TCore extends Record<string, unknown> = Record<string, unknown>>(doc: Partial<MandateJSON<TCore>>): string {
  const m = deepClone(doc); delete (m as any).signatures;
  const jcs = canonicalize(m); if (!jcs) throw new Error("canonicalize() empty");
  return jcs;
}
function computeMandateHash<TCore extends Record<string, unknown> = Record<string, unknown>>(doc: Partial<MandateJSON<TCore>>): Bytes32 {
  return keccak256(toUtf8Bytes(canonicalizeForHash(doc))) as Bytes32;
}

export class Mandate<TCore extends Record<string, unknown> = Record<string, unknown>> {
  /** ---- Native primitive registry (per-process, global) ---- */
  private static registry = new Map<PrimitiveKind, PrimitiveDef<any>>();

  /** Register once on package load (or by plugin packages). */
  static registerPrimitive<T>(def: PrimitiveDef<T>) {
    if (this.registry.has(def.kind)) throw new Error(`Primitive already registered: ${def.kind}`);
    this.registry.set(def.kind, def);
  }
  static getPrimitive<T>(kind: PrimitiveKind): PrimitiveDef<T> {
    const def = this.registry.get(kind);
    if (!def) throw new Error(`Unknown primitive: ${kind}`);
    return def as PrimitiveDef<T>;
  }
  static hasPrimitive(kind: PrimitiveKind) { return this.registry.has(kind); }

  /** ------------ instance data ------------ */
  private m: MandateBase<TCore> & Partial<{ signatures: MandateSignatures }>;

  constructor(init: MandateInit<TCore>) {
    if (!init.client || !init.server) throw new Error("client and server (CAIP-10) are required");
    if (!init.deadline) throw new Error("deadline (ISO 8601) is required");
    this.m = {
      mandateId: init.mandateId ?? ulid(),
      version: init.version,
      client: init.client,
      server: init.server,
      createdAt: init.createdAt ?? new Date().toISOString(),
      deadline: init.deadline,
      intent: init.intent ?? "",
      core: (init.core ?? {}) as TCore,
    };
    if (init.signatures) this.m.signatures = init.signatures as MandateSignatures;
  }

  /* ------------ convenience views ------------ */
  toJSON(): MandateJSON<TCore> | (MandateBase<TCore> & { signatures?: MandateSignatures }) {
    return deepClone(this.m) as any;
  }
  toCanonicalString(): string { return canonicalizeForHash(this.m); }
  mandateHash(): Bytes32 { return computeMandateHash(this.m); }

  /* ------------ core helpers (native & swappable) ------------ */

  /** Set core with a primitive kind and validate via registered validator. */
  setCore<K extends PrimitiveKind, T>(kind: K, payload: unknown): this {
    const def = Mandate.getPrimitive<T>(kind);
    const typed = def.validator.parse(payload); // throws on invalid
    // store uniformly as { kind, payload }
    (this.m as any).core = { kind, payload: typed };
    return this;
  }

  /** Check if this mandate uses a given primitive kind. */
  is(kind: PrimitiveKind): boolean {
    const core: any = (this.m as any).core;
    return !!core && core.kind === kind;
  }

  /** One-liner: get typed payload via a known schema/validator. */
  coreAs<T>(schema: PrimitiveValidator<T>, expectedKind?: PrimitiveKind): T {
    const core: any = (this.m as any).core;
    if (!core || typeof core !== "object") throw new Error("core missing");
    if (expectedKind && core.kind !== expectedKind) {
      throw new Error(`core.kind mismatch: expected ${expectedKind}, got ${core.kind}`);
    }
    return schema.parse(core.payload);
  }

  /** One-liner using registry kind (no schema param). */
  coreAsKind<T>(kind: PrimitiveKind): T {
    const core: any = (this.m as any).core;
    if (!core || core.kind !== kind) throw new Error(`core.kind mismatch: expected ${kind}`);
    const def = Mandate.getPrimitive<T>(kind);
    return def.validator.parse(core.payload);
  }

  /** Safe variant (no throw). */
  tryCoreAs<T>(schema: PrimitiveValidator<T>, expectedKind?: PrimitiveKind): T | null {
    try { return this.coreAs(schema, expectedKind); } catch { return null; }
  }

  /* ------------ signing & verification (unchanged) ------------ */

  private attachSig(role: "client" | "server", sig: Signature) {
    this.m.signatures = this.m.signatures || ({} as MandateSignatures);
    if (role === "client") this.m.signatures.clientSig = sig; else this.m.signatures.serverSig = sig;
  }

  async sign(
    role: "client" | "server",
    wallet: HDNodeWallet,
    alg: SigAlg = "eip191",
    domain?: TypedDataDomain
  ): Promise<Signature> {
    const jcs = this.toCanonicalString();
    const mandateHash = keccak256(toUtf8Bytes(jcs)) as Bytes32;
    let signature: Hex;

    if (alg === "eip191") signature = (await wallet.signMessage(toUtf8Bytes(jcs))) as Hex;
    else if (alg === "eip712") {
      if (!domain || typeof domain.chainId !== "number") throw new Error("EIP-712 requires domain");
      const types = { Mandate: [{ name: "mandateHash", type: "bytes32" }] as const };
      signature = (await wallet.signTypedData(domain, types as any, { mandateHash })) as Hex;
    } else throw new Error(`Unsupported alg: ${alg}`);

    const sig: Signature = { alg, mandateHash, signature };
    this.attachSig(role, sig);
    return sig;
  }

  signAsClient(w: HDNodeWallet, alg: SigAlg = "eip191", d?: TypedDataDomain) { return this.sign("client", w, alg, d); }
  signAsServer(w: HDNodeWallet, alg: SigAlg = "eip191", d?: TypedDataDomain) { return this.sign("server", w, alg, d); }

  verifyRole(role: "client" | "server", domain?: TypedDataDomain): VerifyResult {
    if (!this.m.signatures) throw new Error("no signatures");
    const sigObj = role === "client" ? this.m.signatures.clientSig : this.m.signatures.serverSig;
    if (!sigObj) throw new Error(`${role}Sig missing`);
    const { alg, mandateHash, signature } = sigObj;

    const recomputed = this.mandateHash();
    if (mandateHash.toLowerCase() !== recomputed.toLowerCase()) {
      throw new Error(`${role}Sig.mandateHash mismatch`);
    }

    let recovered: string;
    if (alg === "eip191") recovered = verifyMessage(toUtf8Bytes(this.toCanonicalString()), signature);
    else {
      if (!domain || typeof domain.chainId !== "number") throw new Error("EIP-712 requires domain");
      const types = { Mandate: [{ name: "mandateHash", type: "bytes32" }] as const };
      recovered = verifyTypedData(domain, types as any, { mandateHash }, signature);
    }

    const expected = (this.m as any)[role].split(":")[2].toLowerCase();
    if (recovered.toLowerCase() !== expected) {
      throw new Error(`${role} signature invalid: expected ${expected}, got ${recovered}`);
    }
    return { ok: true, recovered, recomputedHash: recomputed, alg };
  }

  verifyAll(dc?: TypedDataDomain, ds?: TypedDataDomain): VerifyAllResult {
    return { client: this.verifyRole("client", dc), server: this.verifyRole("server", ds) };
  }

  static fromObject<TC extends Record<string, unknown>>(obj: MandateJSON<TC> | MandateBase<TC> & { signatures?: MandateSignatures }) {
    return new Mandate<TC>(obj as MandateInit<TC>);
  }
}
