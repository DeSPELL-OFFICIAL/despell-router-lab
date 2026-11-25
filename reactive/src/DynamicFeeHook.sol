// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title DynamicFeeHook
/// @notice Uniswap v4 hook for the DeSpell router lab test pool. One owner can change the LP fee of the
///         dynamic-fee pools that use this hook, and every change is announced by one `FeeUpdated` event.
/// @dev The PoolManager emits nothing when a dynamic LP fee changes, and other hooks announce fee changes in
///      their own ways (or not at all). This hook gives a Reactive contract a single event to subscribe to.
///      It only sets fees: it never holds, takes or moves tokens.
contract DynamicFeeHook is BaseHook {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;

    /// @notice The only account that may create pools on this hook and change their fee.
    address public immutable owner;

    /// @notice LP fee every pool starts with, in hundredths of a bip (500 = 0.05%).
    uint24 public immutable initialFee;

    /// @notice A pool's LP fee changed. Also emitted when a new pool gets its first fee (`oldFee` is then 0).
    /// @param poolId The v4 pool id (`keccak256(abi.encode(poolKey))`).
    /// @param oldFee The fee before the change, in hundredths of a bip.
    /// @param newFee The fee after the change, in hundredths of a bip.
    event FeeUpdated(PoolId indexed poolId, uint24 oldFee, uint24 newFee);

    /// @dev The caller (or the account that initialized the pool) is not the owner.
    error NotOwner();
    /// @dev The owner passed to the constructor is the zero address.
    error ZeroOwner();
    /// @dev The pool was created with a static fee, so its fee can never change.
    error NotDynamicFee();
    /// @dev The new fee equals the current fee. Nothing changes, so no event is emitted.
    error FeeUnchanged(uint24 fee);

    constructor(IPoolManager _poolManager, address _owner, uint24 _initialFee) BaseHook(_poolManager) {
        if (_owner == address(0)) revert ZeroOwner();
        _initialFee.validate();
        owner = _owner;
        initialFee = _initialFee;
    }

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.afterInitialize = true;
    }

    /// @notice Changes the LP fee of one pool that uses this hook. Owner only.
    /// @param key The pool key. Its `hooks` must be this contract and its fee must be dynamic.
    /// @param newFee The new LP fee in hundredths of a bip, at most 1_000_000 (100%).
    function setFee(PoolKey calldata key, uint24 newFee) external onlyValidPools(key.hooks) {
        if (msg.sender != owner) revert NotOwner();
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();

        PoolId poolId = key.toId();
        uint24 oldFee = feeOf(poolId);
        if (newFee == oldFee) revert FeeUnchanged(newFee);

        // Validates the fee and reverts if the pool is not initialized.
        poolManager.updateDynamicLPFee(key, newFee);
        emit FeeUpdated(poolId, oldFee, newFee);
    }

    /// @notice The LP fee the PoolManager currently charges in a pool, in hundredths of a bip.
    function feeOf(PoolId poolId) public view returns (uint24 lpFee) {
        (,,, lpFee) = poolManager.getSlot0(poolId);
    }

    /// @dev Only the owner may create pools on this hook, so the `FeeUpdated` stream carries only our pools.
    ///      A dynamic-fee pool starts at 0, so the hook sets `initialFee` before anyone can trade.
    function _afterInitialize(address sender, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
        if (sender != owner) revert NotOwner();
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();

        poolManager.updateDynamicLPFee(key, initialFee);
        emit FeeUpdated(key.toId(), 0, initialFee);
        return this.afterInitialize.selector;
    }
}
