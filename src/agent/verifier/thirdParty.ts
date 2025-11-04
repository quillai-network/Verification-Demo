// verifier/thirdParty.ts
import { Mandate, addrFromCaip10 } from "../../core/mandate";
import type { TypedDataDomain } from "ethers";

// Optional: your primitive guard (use your registry/zod later)
export type SwapPayload = {
  chainId: number; tokenIn: string; tokenOut: string;
  amountIn: string; minOut: string; recipient: string; deadline: string;
};
export type SwapCore = { kind: "swap@1"; payload: SwapPayload };

function isSwapCore(x: unknown): x is SwapCore {
  const o = x as any;
  return o && o.kind === "swap@1" && o.payload && typeof o.payload.amountIn === "string";
}

type VerifyOptions = {
  // (optional) enforce who the parties MUST be (plain 0x addresses)
  requireClient?: string;
  requireServer?: string;
  // (optional) deadline check reference time
  now?: Date;
  // (optional) if signatures used EIP-712, pass the domains used at signing
  eip712ClientDomain?: TypedDataDomain;
  eip712ServerDomain?: TypedDataDomain;
  // (optional) primitive guard
  primitive?: "swap@1";
};

export function verifyMandateAsThirdParty(
  mandateJson: unknown,
  opts: VerifyOptions = {}
) {
  const m = Mandate.fromObject(mandateJson as any);

  // 1) Verify both signatures (includes hash recompute + recovery)
  const sigs = m.verifyAll(opts.eip712ClientDomain, opts.eip712ServerDomain);

  // 2) Optional identity checks (CAIP-10 -> 0x)
  const j = m.toJSON();
  const clientAddr = addrFromCaip10(j.client).toLowerCase();
  const serverAddr = addrFromCaip10(j.server).toLowerCase();

  if (opts.requireClient && clientAddr !== opts.requireClient.toLowerCase()) {
    throw new Error(`client mismatch: expected ${opts.requireClient}, got ${clientAddr}`);
  }
  if (opts.requireServer && serverAddr !== opts.requireServer.toLowerCase()) {
    throw new Error(`server mismatch: expected ${opts.requireServer}, got ${serverAddr}`);
  }

  // 3) Optional deadline check
  const now = (opts.now ?? new Date()).getTime();
  if (now > new Date(j.deadline).getTime()) {
    throw new Error("mandate deadline has passed");
  }

  // 4) Optional primitive validation (example: swap@1)
  if (opts.primitive === "swap@1") {
    if (!isSwapCore(j.core)) throw new Error("unexpected core shape for swap@1");
    // add any business rules you want:
    if (j.core.payload.amountIn === "0") throw new Error("bad amountIn");
  }

  return {
    ok: true as const,
    parties: { client: clientAddr, server: serverAddr },
    signatures: sigs,                       // { client: {...}, server: {...} }
    mandateHash: m.mandateHash(),           // canonical hash Agent C can persist
    core: j.core,                           // validated or free-form
  };
}
