// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Script.sol";

import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "./BaseSepolia.sol";
import {TestPoolScript} from "./TestPoolScript.sol";

/// @notice Changes the test pool's LP fee (one transaction, emits FeeUpdated). NEW_FEE is in hundredths of
///         a bip: 500 = 0.05%, 100000 = 10%.
/// @dev NEW_FEE=100000 forge script script/SetFee.s.sol --rpc-url base_sepolia --broadcast
///      (run through scripts/with-key.mjs; the hook comes from HOOK or deployments/base-sepolia.json)
contract SetFee is TestPoolScript {
    function run() external returns (uint24 oldFee, uint24 newFee) {
        uint256 fee = vm.envUint("NEW_FEE");
        // Check before narrowing: a mistyped value must not wrap into some other valid fee.
        require(fee <= LPFeeLibrary.MAX_LP_FEE, "NEW_FEE above 1000000 (100%)");
        return setFee(DynamicFeeHook(address(_hook())), uint24(fee));
    }

    function setFee(DynamicFeeHook hook, uint24 fee) public returns (uint24 oldFee, uint24 newFee) {
        _requireBaseSepolia();
        newFee = fee;
        PoolKey memory key = BaseSepolia.poolKey(hook);
        PoolId poolId = key.toId();

        oldFee = hook.feeOf(poolId);
        vm.startBroadcast(_deployerKey());
        hook.setFee(key, newFee);
        vm.stopBroadcast();

        console.log("lp fee before:", oldFee);
        console.log("lp fee after:", hook.feeOf(poolId));
    }
}
