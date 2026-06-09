// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract FlowPay {
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 public constant INTERVAL_THIRTY_MIN = 30 minutes;
    uint256 public constant INTERVAL_HOURLY  = 1 hours;
    uint256 public constant INTERVAL_DAILY   = 1 days;
    uint256 public constant INTERVAL_WEEKLY  = 7 days;
    uint256 public constant INTERVAL_MONTHLY = 30 days;
    uint256 public constant MAX_STREAMS_PER_USER = 20;

    enum Interval { ThirtyMin, Hourly, Daily, Weekly, Monthly }

    struct Stream {
        uint256 id;
        address sender;
        address recipient;
        uint256 amountPerInterval;
        Interval interval;
        uint256 startTime;
        uint256 lastExecuted;
        uint256 totalDeposited;
        uint256 totalPaid;
        bool    active;
        string  label;
    }

    uint256 private _nextStreamId = 1;
    mapping(uint256 => Stream) public streams;
    mapping(address => uint256[]) private _userStreams;

    event StreamCreated(uint256 indexed streamId, address indexed sender, address indexed recipient, uint256 amountPerInterval, Interval interval, uint256 deposit, string label, uint256 startTime);
    event PaymentExecuted(uint256 indexed streamId, address indexed recipient, uint256 amount, uint256 timestamp);
    event StreamCancelled(uint256 indexed streamId, address indexed sender, uint256 refundAmount);
    event ToppedUp(uint256 indexed streamId, address indexed sender, uint256 amount);

    modifier onlySender(uint256 streamId) {
        require(streams[streamId].sender == msg.sender, "FlowPay: not stream owner");
        _;
    }

    modifier streamExists(uint256 streamId) {
        require(streams[streamId].id != 0, "FlowPay: stream does not exist");
        _;
    }

    function createStream(
        address recipient,
        uint256 amountPerInterval,
        Interval interval,
        uint256 deposit,
        string calldata label,
        uint256 startTime
    ) external returns (uint256 streamId) {
        require(recipient != address(0), "FlowPay: zero recipient");
        require(recipient != msg.sender, "FlowPay: cannot stream to self");
        require(amountPerInterval > 0, "FlowPay: zero amount");
        require(deposit >= amountPerInterval, "FlowPay: deposit below one interval");
        require(_userStreams[msg.sender].length < MAX_STREAMS_PER_USER, "FlowPay: max streams reached");
        require(startTime >= block.timestamp, "FlowPay: start time in the past");

        bool ok = IERC20(USDC).transferFrom(msg.sender, address(this), deposit);
        require(ok, "FlowPay: USDC transfer failed");

        streamId = _nextStreamId++;

        // lastExecuted = startTime - interval so first payment fires exactly at startTime
        uint256 secs = intervalSeconds(interval);
        uint256 lastExecuted = startTime - secs;

        streams[streamId] = Stream({
            id: streamId,
            sender: msg.sender,
            recipient: recipient,
            amountPerInterval: amountPerInterval,
            interval: interval,
            startTime: startTime,
            lastExecuted: lastExecuted,
            totalDeposited: deposit,
            totalPaid: 0,
            active: true,
            label: label
        });

        _userStreams[msg.sender].push(streamId);
        emit StreamCreated(streamId, msg.sender, recipient, amountPerInterval, interval, deposit, label, startTime);
    }

    function executePayment(uint256 streamId) external streamExists(streamId) {
        Stream storage s = streams[streamId];
        require(s.active, "FlowPay: stream not active");
        require(block.timestamp >= _nextDueTime(s), "FlowPay: payment not yet due");
        uint256 balance = _streamBalance(s);
        require(balance >= s.amountPerInterval, "FlowPay: insufficient stream balance");
        s.lastExecuted = block.timestamp;
        s.totalPaid += s.amountPerInterval;
        bool ok = IERC20(USDC).transfer(s.recipient, s.amountPerInterval);
        require(ok, "FlowPay: USDC transfer failed");
        emit PaymentExecuted(streamId, s.recipient, s.amountPerInterval, block.timestamp);
        if (_streamBalance(s) < s.amountPerInterval) { s.active = false; }
    }

    function topUp(uint256 streamId, uint256 amount) external streamExists(streamId) onlySender(streamId) {
        require(amount > 0, "FlowPay: zero amount");
        bool ok = IERC20(USDC).transferFrom(msg.sender, address(this), amount);
        require(ok, "FlowPay: USDC transfer failed");
        streams[streamId].totalDeposited += amount;
        if (!streams[streamId].active && _streamBalance(streams[streamId]) >= streams[streamId].amountPerInterval) {
            streams[streamId].active = true;
        }
        emit ToppedUp(streamId, msg.sender, amount);
    }

    function cancelStream(uint256 streamId) external streamExists(streamId) onlySender(streamId) {
        Stream storage s = streams[streamId];
        require(s.active || _streamBalance(s) > 0, "FlowPay: nothing to cancel");
        s.active = false;
        uint256 refund = _streamBalance(s);
        if (refund > 0) {
            s.totalPaid += refund;
            bool ok = IERC20(USDC).transfer(msg.sender, refund);
            require(ok, "FlowPay: refund failed");
        }
        emit StreamCancelled(streamId, msg.sender, refund);
    }

    function checker(uint256 streamId) external view returns (bool canExec, bytes memory execPayload) {
        Stream storage s = streams[streamId];
        if (!s.active) return (false, bytes("stream inactive"));
        if (s.id == 0)  return (false, bytes("stream not found"));
        if (block.timestamp < _nextDueTime(s)) return (false, bytes("not yet due"));
        if (_streamBalance(s) < s.amountPerInterval) return (false, bytes("insufficient balance"));
        canExec = true;
        execPayload = abi.encodeWithSelector(this.executePayment.selector, streamId);
    }

    function getStream(uint256 streamId) external view returns (Stream memory) { return streams[streamId]; }
    function getUserStreams(address user) external view returns (uint256[] memory) { return _userStreams[user]; }
    function streamBalance(uint256 streamId) external view streamExists(streamId) returns (uint256) { return _streamBalance(streams[streamId]); }
    function nextDueTime(uint256 streamId) external view streamExists(streamId) returns (uint256) { return _nextDueTime(streams[streamId]); }

    function intervalSeconds(Interval interval) public pure returns (uint256) {
        if (interval == Interval.ThirtyMin) return INTERVAL_THIRTY_MIN;
        if (interval == Interval.Hourly)  return INTERVAL_HOURLY;
        if (interval == Interval.Daily)   return INTERVAL_DAILY;
        if (interval == Interval.Weekly)  return INTERVAL_WEEKLY;
        return INTERVAL_MONTHLY;
    }

    function _streamBalance(Stream storage s) internal view returns (uint256) {
        if (s.totalDeposited <= s.totalPaid) return 0;
        return s.totalDeposited - s.totalPaid;
    }

    function _nextDueTime(Stream storage s) internal view returns (uint256) {
        return s.lastExecuted + intervalSeconds(s.interval);
    }
}
