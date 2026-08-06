// OpenClaw has two different reply-delivery fields with similar names:
//
// - the inbound reply plan describes the channel target (channel/reply/etc.);
// - the dispatcher policy decides whether normal model text is delivered
//   automatically or only through the message tool.
//
// Keep them separate. Putting "automatic" into the inbound reply plan does
// not configure the dispatcher and can leave a completed model turn with no
// visible Room payload.
export const ROOM_REPLY_PLAN_DELIVERY_MODE = "channel";
export const ROOM_DISPATCH_REPLY_DELIVERY_MODE = "automatic";

export function roomReplyDeliveryPolicy() {
  return {
    replyPlan: {sourceReplyDeliveryMode: ROOM_REPLY_PLAN_DELIVERY_MODE},
    replyOptions: {sourceReplyDeliveryMode: ROOM_DISPATCH_REPLY_DELIVERY_MODE},
  };
}
