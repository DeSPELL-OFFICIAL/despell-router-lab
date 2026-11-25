// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";

import {PoolGuard} from "./PoolGuard.sol";

/// @title PoolReflex
/// @notice The DeSpell router's reflex as a Reactive contract. It listens to the test pool hook's `FeeUpdated` on
///         the origin chain and, without waiting for any AI review, asks PoolGuard on the destination chain to mark
///         the pool. It can only ask PoolGuard to tighten; reopening is the owner's job there.
/// @dev Runs on Reactive Network (Lasna testnet). The reflex table is the router's `POOL_REFLEX_BY_CHANGE`: the
///      test pool can only change its fee, so only `fee_changed` is wired to an event; the rest is the table itself.
contract PoolReflex is AbstractReactive {
    /// @notice keccak256("FeeUpdated(bytes32,uint24,uint24)"), emitted by the test pool's hook.
    uint256 public constant FEE_UPDATED_TOPIC0 = 0x96a011a1e8a72dbc16d5af5d8f0db6bf107a76580682a94073bb6ffec86a0872;
    bytes32 public constant FEE_CHANGED = "fee_changed";
    /// @notice Gas for the PoolGuard callback. The proxy keeps 80k + 50k of it for its own accounting; `mark` needs
    ///         about 75k. The fee is charged on gas used, not on this limit.
    uint64 public constant CALLBACK_GAS_LIMIT = 400_000;

    uint256 public immutable originChainId;
    address public immutable hook;
    uint256 public immutable destinationChainId;
    address public immutable owner;

    /// @notice PoolGuard on the destination chain. Set once by the owner after PoolGuard is deployed, because
    ///         PoolGuard needs this contract's address at construction.
    address public guard;

    event GuardSet(address indexed guard);
    /// @notice The reflex fired for one pool change and a mark was requested.
    event Reflex(
        bytes32 indexed poolId,
        bytes32 reason,
        uint8 status,
        uint24 oldFee,
        uint24 newFee,
        uint256 originBlock,
        bytes32 indexed originTx
    );

    error NotOwner();
    error GuardAlreadySet();
    error ZeroAddress();

    constructor(uint256 originChainId_, address hook_, uint256 destinationChainId_, address owner_) payable {
        if (hook_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        originChainId = originChainId_;
        hook = hook_;
        destinationChainId = destinationChainId_;
        owner = owner_;
        SYSTEM.subscribe(originChainId_, hook_, FEE_UPDATED_TOPIC0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function setGuard(address guard_) external {
        if (msg.sender != owner) revert NotOwner();
        if (guard != address(0)) revert GuardAlreadySet();
        if (guard_ == address(0)) revert ZeroAddress();
        guard = guard_;
        emit GuardSet(guard_);
    }

    /// @notice The router's reflex for each change kind: 3 block, 2 narrow (restrict), 0 no mark.
    /// @dev `paused` closes the route but keeps the trust level, and `stale` changes nothing, so neither is a mark.
    function reflexFor(bytes32 kind) public pure returns (uint8) {
        if (
            kind == "code_changed" || kind == "token_code_changed" || kind == "implementation_changed"
                || kind == "sell_reverted"
        ) return 3;
        if (
            kind == "owner_changed" || kind == FEE_CHANGED || kind == "reserve_below_band"
                || kind == "round_trip_loss_up"
        ) return 2;
        return 0;
    }

    /// @dev Never reverts on a log it ignores: Reactive bills a reverted `react` in full.
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != originChainId || log_.contractAddress != hook || log_.topic0 != FEE_UPDATED_TOPIC0) return;
        address target = guard;
        if (target == address(0)) return;

        (uint24 oldFee, uint24 newFee) = abi.decode(log_.data, (uint24, uint24));
        bytes32 poolId = bytes32(log_.topic1);
        bytes32 originTx = bytes32(log_.txHash);
        uint8 status = reflexFor(FEE_CHANGED);

        // The proxy replaces the first argument with this contract's address.
        bytes memory payload =
            abi.encodeCall(PoolGuard.mark, (address(0), poolId, status, FEE_CHANGED, log_.blockNumber, originTx));
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: destinationChainId, recipient: target, gasLimit: CALLBACK_GAS_LIMIT, payload: payload
            })
        );
        emit Reflex(poolId, FEE_CHANGED, status, oldFee, newFee, log_.blockNumber, originTx);
    }

    /// @notice Pays any debt to the system contract from this contract's balance. Anyone may call it.
    function coverDebt() external {
        _coverDebt();
    }
}
