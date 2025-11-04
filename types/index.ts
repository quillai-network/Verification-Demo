export interface SwapRequest {
  id: string;
  fromToken: string; // USDC
  toToken: string;   // ETH
  amount: string;    // "1" for 1 USDC
  network: string;   // "sepolia"
  requesterAgentId: string;
  timestamp: number;
}

export interface SwapQuote {
  id: string;
  swapRequestId: string;
  providerAgentId: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
  gasEstimate: string;
  route: string[];
  deadline: number;
  timestamp: number;
}

export interface SwapAcceptance {
  id: string;
  swapQuoteId: string;
  requesterAgentId: string;
  timestamp: number;
}

export interface SwapExecution {
  id: string;
  swapQuoteId: string;
  txHash: string;
  proofCid: string; // IPFS CID for swap proof
  status: 'success' | 'failed';
  timestamp: number;
  feedbackAuth?: string; // optional feedback authorization blob from provider
}

export interface AgentFeedback {
  id: string;
  targetAgentId: string;
  rating: number; // 1-100
  feedbackUri: string; // IPFS URI
  swapExecutionId: string;
  timestamp: number;
}

export interface AgentConfig {
  name: string;
  domain: string;
  role: 'SERVER' | 'CLIENT';
  privateKey: string;
  xmtpPrivateKey: string;
  network: string;
}

export const MESSAGE_TYPES = {
  SWAP_REQUEST: 'swap_request',
  SWAP_QUOTE: 'swap_quote',
  SWAP_ACCEPTANCE: 'swap_acceptance',
  SWAP_EXECUTION: 'swap_execution',
  AGENT_FEEDBACK: 'agent_feedback',
  MANDATE: 'mandate', // Server sends signed mandate to client
  MANDATE_COUNTERSIGNED: 'mandate_countersigned', // Client sends back countersigned mandate
} as const;

export type MessageType = typeof MESSAGE_TYPES[keyof typeof MESSAGE_TYPES];
