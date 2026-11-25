import { parseAbi, parseAbiParameters } from "viem";

/* Only the functions and events the swap card builds, decodes or reads. */

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/** USDC (Mock) on GIWA Sepolia: anyone can mint. */
export const mockMintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/** Input of the Universal Router V4_SWAP command: V4Router actions and one encoded parameter block per action. */
export const v4SwapInput = parseAbiParameters("bytes actions, bytes[] params");

const POOL_KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

/** IV4Router.ExactInputSingleParams */
export const v4ExactInSingle = parseAbiParameters(
  `(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`,
);
/** SETTLE_ALL: (currency, maxAmount) */
export const v4SettleAll = parseAbiParameters("address currency, uint256 maxAmount");
/** TAKE: (currency, recipient, amount); amount 0 = the whole open credit */
export const v4Take = parseAbiParameters("address currency, address recipient, uint256 amount");

export const v4QuoterAbi = parseAbi([
  `function quoteExactInputSingle((${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);

export const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);

export const swapRouter02Abi = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
]);

/** Events read from a swap receipt to show what arrived. */
export const v4PoolManagerSwapEvent = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
export const wethWithdrawalEvent = parseAbi(["event Withdrawal(address indexed src, uint256 wad)"]);
