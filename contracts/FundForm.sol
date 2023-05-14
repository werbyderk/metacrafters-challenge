// SPDX-License-Identifier: MIT
pragma solidity ^0.8.16;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "./FundToken.sol";

contract FundForm is UUPSUpgradeable, OwnableUpgradeable {
    struct Campaign {
        address creator;
        uint64 deadline;
        uint goal;
        mapping(address => uint) pledgedAmounts;
        uint totalPledged;
    }
    mapping(uint => Campaign) public campaigns;
    uint internal nextCampaignId;
    FundToken public token;

    event NewCampaign(address indexed creator, uint indexed campaignId);

    modifier onlyActiveCampaign(uint _campaignId) {
        Campaign storage campaign = campaigns[_campaignId];

        require(campaign.creator != address(0), "Campaign does not exist");
        require(
            campaign.deadline >= block.timestamp,
            "This campaign has expired."
        );
        _;
    }

    modifier onlyExpiredCampaign(uint _campaignId) {
        uint deadline = campaigns[_campaignId].deadline;
        require(deadline != 0, "This campaign is archived.");
        require(deadline < block.timestamp, "This campaign is active.");
        _;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    function _transfer(address _to, uint _amount) internal {
        bool success = token.transfer(_to, _amount);
        require(success, "Transfer failed.");
    }

    function _transferFrom(address _from, address _to, uint _amount) internal {
        bool success = token.transferFrom(_from, _to, _amount);
        require(success, "Transfer failed.");
    }

    function initialize(address _token) public initializer onlyProxy {
        __Ownable_init();
        token = FundToken(_token);
    }

    function createCampaign(uint _goal, uint64 _deadline) public {
        require(_deadline > block.timestamp, "Invalid deadline.");
        require(_goal > 0, "Invalid goal.");
        Campaign storage campaign = campaigns[nextCampaignId];
        campaign.creator = msg.sender;
        campaign.goal = _goal;
        campaign.deadline = _deadline;

        emit NewCampaign(msg.sender, nextCampaignId++);
    }

    function withdrawFunds(
        uint _campaignId
    ) public onlyExpiredCampaign(_campaignId) {
        Campaign storage campaign = campaigns[_campaignId];
        require(campaign.totalPledged >= campaign.goal, "Goal not met.");
        campaign.deadline = 0;
        _transfer(campaign.creator, campaign.totalPledged);
    }

    function pledge(
        uint _campaignId,
        uint _amount,
        uint _permitDeadline,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) public onlyActiveCampaign(_campaignId) {
        Campaign storage campaign = campaigns[_campaignId];
        campaign.pledgedAmounts[msg.sender] += _amount;
        campaign.totalPledged += _amount;
        token.permit(
            msg.sender,
            address(this),
            _amount,
            _permitDeadline,
            _v,
            _r,
            _s
        );
        _transferFrom(msg.sender, address(this), _amount);
    }

    function removePledge(
        uint _campaignId
    ) public onlyExpiredCampaign(_campaignId) {
        Campaign storage campaign = campaigns[_campaignId];
        require(campaign.totalPledged < campaign.goal, "Campaign goal was met");
        uint pledgedAmount = campaign.pledgedAmounts[msg.sender];
        campaign.pledgedAmounts[msg.sender] = 0;
        campaign.totalPledged -= pledgedAmount;
        _transfer(msg.sender, pledgedAmount);
    }

    function isArchivedCampaign(uint _campaignId) public view returns (bool) {
        return campaigns[_campaignId].deadline == 0;
    }
}
