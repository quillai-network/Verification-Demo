/**
 * @author Joey
 * @description Minimal, schema aligned types for mandates
 */

export type CAIP10 = `eip155:${number}:${`0x${string}`}`;
export type ISO8601 = string;
export type Hex = `0x${string}`;
export type Bytes32 = `0x${string}`; // enforce at runtime (regex) if needed

export type SigAlg = "eip191" | "eip712";

export interface Signature {
  alg: SigAlg;
  mandateHash: Bytes32; // keccak256(JCS(mandateWithoutSignatures))
  signature: Hex;       // e.g., 65-byte r||s||v
}

export interface MandateSignatures {
  clientSig: Signature;
  serverSig: Signature;
}

export interface MandateBase<TCore extends Record<string, unknown> = Record<string, unknown>> {
  mandateId: string;     // ULID or UUIDv7
  version: string;       // semver "MAJOR.MINOR.PATCH"
  client: CAIP10;        // eip155:<chainId>:<0xaddr>
  server: CAIP10;        // eip155:<chainId>:<0xaddr>
  createdAt: ISO8601;    // ISO 8601
  deadline: ISO8601;     // ISO 8601
  intent: string;        // free text
  core: TCore; // free-form payload (primitive-defined)
}

export type MandateJSON<TCore extends Record<string, unknown> = Record<string, unknown>> = MandateBase<TCore> & { signatures: MandateSignatures };

export type MandateInit<TCore extends Record<string, unknown> = Record<string, unknown>> = Omit<MandateBase<TCore>, "mandateId" | "createdAt"> & {
  mandateId?: string;
  createdAt?: ISO8601;
  signatures?: Partial<MandateSignatures>; // optional on construct
};

// Convenience result shapes
export interface VerifyResult {
  ok: true;
  recovered: string;           // 0x-address
  recomputedHash: Bytes32;
  alg: SigAlg;
}
export interface VerifyAllResult {
  client: VerifyResult;
  server: VerifyResult;
}


export type SwapPayload = {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    minOut: string;
    recipient: string;
    deadline: string;
  };
export type SwapCore = { kind: "swap@1"; payload: SwapPayload };