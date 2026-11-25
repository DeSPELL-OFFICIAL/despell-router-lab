// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";

/// @notice Chains, addresses and amounts shared by the reflex scripts.
/// @dev Reactive addresses: https://dev.reactive.network/origins-and-destinations (Base Sepolia callback proxy) and
///      https://dev.reactive.network/reactive-mainnet (Lasna, faucet). Test pool: ../deployments/base-sepolia.json.
abstract contract ReflexConfig is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant LASNA = 5318007;

    address internal constant HOOK = 0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000;
    bytes32 internal constant POOL_ID = 0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4;
    /// @notice Reactive's callback proxy on Base Sepolia.
    address internal constant CALLBACK_PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    /// @notice Reactive's faucet on Base Sepolia: `request(address)` with ETH, 1 ETH -> 100 lREACT on Lasna.
    address internal constant LREACT_FAUCET = 0x2afaFD298b23b62760711756088F75B7409f5967;

    function _key() internal view returns (uint256) {
        return vm.envUint("PRIVATE_KEY");
    }

    function _requireChain(uint256 chainId) internal view {
        require(block.chainid == chainId, "wrong chain for this script");
    }
}
