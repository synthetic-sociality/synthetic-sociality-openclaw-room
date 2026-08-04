// OpenClaw accepts only "automatic" or "message_tool_only" here. Room turns
// must use automatic source delivery so the model's final reply reaches the
// channel adapter without requiring the model to discover or call a tool.
export const ROOM_SOURCE_REPLY_DELIVERY_MODE = "automatic";
