// SPDX-License-Identifier: MIT
pragma solidity ^0.8.16;

import "./FundForm.sol";

contract FundFormV2 is FundForm {
    function cancelCampaign(
        uint _campaignId
    ) public onlyActiveCampaign(_campaignId) {
        Campaign storage campaign = campaigns[_campaignId];
        if (campaign.creator != msg.sender) {
            _checkOwner();
        }
        campaign.deadline = 0;
    }
}
