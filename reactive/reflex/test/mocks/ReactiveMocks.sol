// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @notice Stands in for Reactive's system contract (0x8888…8888): records subscriptions and callback requests.
contract MockSystem {
    struct Subscription {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    Subscription[] public subscriptions;
    ISystemContract.CallbackConfiguration_V_1_0[] internal _requests;
    address[] public requesters;

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        subscriptions.push(Subscription(c, a, t0, t1, t2, t3));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config) external {
        _requests.push(config);
        requesters.push(msg.sender);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function request(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) {
        return _requests[i];
    }

    receive() external payable {}
}

/// @notice Stands in for Reactive's callback proxy on the destination chain. Like the real one, it overwrites the
///         first argument of the payload with the address of the reactive contract that requested the callback,
///         and keeps 80k + 50k gas of the limit for its own accounting.
contract MockCallbackProxy {
    uint256 internal constant RESERVED_GAS = 130_000;

    event Delivered(address recipient, bool ok, bytes result);

    function deliver(address requester, ISystemContract.CallbackConfiguration_V_1_0 memory config)
        external
        returns (bool ok, bytes memory result)
    {
        bytes memory payload = config.payload;
        assembly {
            // payload layout: [length][selector (4)][arg0 (32)]…; arg0 starts at payload + 32 + 4.
            mstore(add(payload, 36), requester)
        }
        (ok, result) = config.recipient.call{gas: config.gasLimit - RESERVED_GAS}(payload);
        emit Delivered(config.recipient, ok, result);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}
