// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {TestPoolScript} from "./TestPoolScript.sol";
import {BaseSepolia} from "./BaseSepolia.sol";

/// @notice Adds one more ETH-only position of SEED_WEI just above the current price (one transaction).
/// @dev SEED_WEI=<wei> forge script script/Seed.s.sol --rpc-url base_sepolia --broadcast
///      (run through scripts/with-key.mjs; the hook comes from HOOK or deployments/base-sepolia.json)
contract Seed is TestPoolScript {
    function run() external returns (uint256 tokenId) {
        return seed(_hook(), vm.envUint("SEED_WEI"));
    }

    function seed(IHooks hook, uint256 seedWei) public returns (uint256 tokenId) {
        _requireBaseSepolia();
        uint256 pk = _deployerKey();
        vm.startBroadcast(pk);
        tokenId = _seed(BaseSepolia.poolKey(hook), seedWei, vm.addr(pk));
        vm.stopBroadcast();
    }
}
