import dotenv from "dotenv";
dotenv.config();

export type TokenRole = "base" | "quote";

const token0Symbol = process.env.TOKEN0_SYMBOL ?? "USDC";
const token1Symbol = process.env.TOKEN1_SYMBOL ?? "WETH";

export interface UniswapConfig {
  rpcUrl: string;
  chainId: number;
  factory: string;
  quoter?: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
}

export const UNISWAP_CFG: UniswapConfig = {
  rpcUrl:process.env.ETHEREUM_SEPOLIA_RPC_URL ?? "",
  chainId: Number(process.env.CHAIN_ID ?? 11155111),
  factory: process.env.UNISWAP_V3_FACTORY ?? "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  quoter: process.env.UNISWAP_V3_QUOTER ?? "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  token0: process.env.TOKEN0_ADDRESS ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  token1: process.env.TOKEN1_ADDRESS ?? "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  token0Decimals: Number(process.env.TOKEN0_DECIMALS ?? 6),
  token1Decimals: Number(process.env.TOKEN1_DECIMALS ?? 18),
  token0Symbol,
  token1Symbol,
  fee: Number(process.env.UNI_FEE ?? 3000),
};


