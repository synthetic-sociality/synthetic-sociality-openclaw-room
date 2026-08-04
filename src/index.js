import {createRoomChannel} from "./channel.js";
import {createRoomClient} from "./runtime.js";

export default createRoomChannel({makeClient: createRoomClient});
