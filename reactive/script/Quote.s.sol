// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Script.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "./BaseSepolia.sol";
import {TestPoolScript} from "./TestPoolScript.sol";

/// @notice Read-only: prints the test pool's state from Uniswap's StateView and a USDC -> ETH quote from
///         Uniswap's V4Quoter. Sends nothing and needs no key.
/// @dev forge script script/Quote.s.sol --rpc-url base_sepolia        (USDC_IN defaults to 10 USDC)
///      Add `--fork-block-number <n>` to read the pool as it was at block n.
contract Quote is TestPoolScript {
    function run() external returns (uint24 lpFee, uint256 ethOut) {
        uint256 usdcIn = vm.envOr("USDC_IN", uint256(10e6));
        require(usdcIn <= type(uint128).max, "USDC_IN too large");
        return quote(_hook(), uint128(usdcIn));
    }

    function quote(IHooks hook, uint128 usdcIn) public returns (uint24 lpFee, uint256 ethOut) {
        _requireBaseSepolia();
        PoolKey memory key = BaseSepolia.poolKey(hook);
        PoolId poolId = key.toId();

        IStateView stateView = IStateView(BaseSepolia.STATE_VIEW);
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        (sqrtPriceX96, tick, protocolFee, lpFee) = stateView.getSlot0(poolId);
        console.log("block:", block.number);
        console.log("hook:", address(hook));
        console.log("pool id:");
        console.logBytes32(PoolId.unwrap(poolId));
        console.log("StateView lpFee:", lpFee);
        console.log("hook feeOf:", DynamicFeeHook(address(hook)).feeOf(poolId));
        console.log("protocolFee:", protocolFee);
        console.log("sqrtPriceX96:", sqrtPriceX96);
        console.log("tick:");
        console.logInt(tick);
        console.log("liquidity:", stateView.getLiquidity(poolId));

        (ethOut,) = IV4Quoter(BaseSepolia.QUOTER)
            .quoteExactInputSingle(
                IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: false, exactAmount: usdcIn, hookData: ""})
            );
        console.log("quote USDC in (6 decimals):", usdcIn);
        console.log("quote ETH out (wei):", ethOut);
    }
}
