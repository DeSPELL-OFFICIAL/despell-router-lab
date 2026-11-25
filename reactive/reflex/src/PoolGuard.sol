// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";

/// @title PoolGuard
/// @notice Public, on-chain marks for pools the DeSpell router may route through. When a pool changes a setting,
///         Reactive Network writes a mark here within seconds, and anyone reads it with `statusOf(poolId)`.
/// @dev Two rules from the router's reflex:
///      - Marks only tighten. A callback that asks for the same or a looser status changes nothing.
///      - Only the owner reopens a pool, after its test trades pass again. A pool that flips its setting back is
///        not reopened, so shaking a pool cannot open the door.
///      The contract holds and moves no one's money. The only ETH it handles pays Reactive's callback fees.
contract PoolGuard is AbstractCallback {
    /// @notice Statuses, loosest to tightest. The same numbers as the router's 2-bit pool judgment.
    uint8 public constant OPEN = 0;
    uint8 public constant SMALL_CAP = 1;
    /// @notice "Narrowed": the router caps the pool at 0.1x its usual limit.
    uint8 public constant NARROWED = 2;
    uint8 public constant BLOCKED = 3;

    struct Mark {
        uint8 status;
        uint64 markedAt; // block timestamp of the mark
        uint64 originBlock; // block of the pool change on the origin chain
        bytes32 reason; // change kind, e.g. "fee_changed"
        bytes32 originTx; // transaction of the pool change
    }

    mapping(bytes32 poolId => Mark) private _marks;

    address public owner;
    address public pendingOwner;

    /// @notice A pool was marked tighter. `originTx` is the pool change that caused it.
    event Marked(
        bytes32 indexed poolId,
        uint8 oldStatus,
        uint8 newStatus,
        bytes32 reason,
        uint256 originBlock,
        bytes32 indexed originTx
    );
    /// @notice A callback asked for a status no tighter than the current one, so nothing changed.
    event MarkKept(bytes32 indexed poolId, uint8 status, uint8 requested, bytes32 reason, bytes32 indexed originTx);
    /// @notice The owner reopened a pool.
    event Reopened(bytes32 indexed poolId, uint8 oldStatus);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error NotMarked(bytes32 poolId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param callbackProxy_ Reactive's callback proxy on this chain (it delivers and bills the callbacks).
    /// @param reflex_ The reactive contract allowed to mark pools (PoolReflex on Reactive Network).
    /// @param owner_ The account that may reopen pools.
    constructor(IPayable callbackProxy_, address reflex_, address owner_)
        payable
        AbstractCallback(callbackProxy_, reflex_)
    {
        if (address(callbackProxy_) == address(0) || reflex_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Called by Reactive's callback proxy. The proxy overwrites the first argument with the address of the
    ///         reactive contract that asked for the callback, so `reflex_` is who sent it, whatever the payload said.
    /// @dev Never reverts on a status it will not apply: a failed callback is still billed. A status above BLOCKED is
    ///      read as BLOCKED, so an unknown request fails closed.
    function mark(address reflex_, bytes32 poolId, uint8 status, bytes32 reason, uint256 originBlock, bytes32 originTx)
        external
        onlyServiceProvider
        onlyCallbackSender(reflex_)
    {
        if (status > BLOCKED) status = BLOCKED;
        Mark storage m = _marks[poolId];
        uint8 oldStatus = m.status;
        if (status <= oldStatus) {
            emit MarkKept(poolId, oldStatus, status, reason, originTx);
            return;
        }
        m.status = status;
        m.markedAt = uint64(block.timestamp);
        m.originBlock = originBlock > type(uint64).max ? type(uint64).max : uint64(originBlock);
        m.reason = reason;
        m.originTx = originTx;
        emit Marked(poolId, oldStatus, status, reason, originBlock, originTx);
    }

    /// @notice Clears a pool's mark. Owner only: the server calls it after the pool's test trades pass again.
    function reopen(bytes32 poolId) external onlyOwner {
        uint8 oldStatus = _marks[poolId].status;
        if (oldStatus == OPEN) revert NotMarked(poolId);
        delete _marks[poolId];
        emit Reopened(poolId, oldStatus);
    }

    /// @notice The pool's status: 0 open, 1 small cap, 2 narrowed (0.1x), 3 blocked.
    function statusOf(bytes32 poolId) external view returns (uint8) {
        return _marks[poolId].status;
    }

    /// @notice The pool's full mark: status, when it was set, and the pool change behind it.
    function markOf(bytes32 poolId) external view returns (Mark memory) {
        return _marks[poolId];
    }

    /// @notice Pays any callback debt from this contract's balance. Anyone may call it.
    function coverDebt() external {
        _coverDebt();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
