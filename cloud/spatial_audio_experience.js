const axios = require("axios");
const { hifiAudioConfig } = require("./common");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const decode = require("audio-decode");
const format = require("audio-format");
const convert = require("pcm-convert");
const { MediaStream } = require("wrtc");
const {
  Point3D,
  HiFiAudioAPIData,
  HiFiCommunicator,
  preciseInterval
} = require("hifi-spatial-audio");
const { SignJWT } = require("jose/dist/node/cjs/jwt/sign"); // Used to create a JWT associated with your Space.

const AUDIO_ROOM_MODEL = "AudioRoom";

const generateSpace = async (vulcanSpaceId, name) => {
  try {
    const response = await axios.get(
      `https://api.highfidelity.com/api/v1/spaces/create?token=${hifiAudioConfig.adminToken}&name=${vulcanSpaceId}_${name}`
    );
    if (!response.data || !response.data["space-id"]) return null;
    return response.data["space-id"];
  } catch (e) {
    console.error(e);
    throw e;
  }
};

const getSpace = async vulcanSpaceId => {
  const SPACE_MAPPING_MODEL = "SpaceMapping";
  try {
    // Find the existing one first.
    const spaceQuery = new Parse.Query(SPACE_MAPPING_MODEL);
    spaceQuery.equalTo("vulcan_space_id", vulcanSpaceId);
    const spaceRecord = await spaceQuery.first({ useMasterKey: true });
    if (!spaceRecord || !spaceRecord.get("space_token")) {
      return "No space!";
    }
    return spaceRecord.get("space_token");
  } catch (e) {
    console.log("error in findOrGenerateSpace", e);
  }
};

Parse.Cloud.define("getSpace", async request => {
  const { vulcanSpaceId } = request.params;
  const spaceToken = await getSpace(vulcanSpaceId);
  return spaceToken;
});

// Hifi Spatial Audio Token
// - Check Parse server for existing space token, return if found
// - generate one if doesn't exist,
// - store newly generated one into Parse
const findOrGenerateSpace = async (vulcanSpaceId, name) => {
  const SPACE_MAPPING_MODEL = "SpaceMapping";
  try {
    // Find the existing one first.
    const spaceQuery = new Parse.Query(SPACE_MAPPING_MODEL);
    spaceQuery.equalTo("vulcan_space_id", vulcanSpaceId);
    const spaceRecord = await spaceQuery.first({ useMasterKey: true });

    if (!spaceRecord || !spaceRecord.get("space_token")) {
      // When no existing record, generate one.
      const spaceToken = await generateSpace(vulcanSpaceId, name);
      if (spaceToken === null) throw "No space token generated";

      // Store newly generated one into Parse Server
      const SpaceMapping = Parse.Object.extend(SPACE_MAPPING_MODEL);
      const newSpaceMappingObject = new SpaceMapping();
      newSpaceMappingObject.set("name", name);
      newSpaceMappingObject.set("vulcan_space_id", vulcanSpaceId);
      newSpaceMappingObject.set("space_token", spaceToken);
      await newSpaceMappingObject.save();
      return spaceToken;
    }
    return spaceRecord.get("space_token");
  } catch (e) {
    console.log("error in findOrGenerateSpace", e);
  }
};

// Cloud function : End point for users for JWT token
// - find or generate space id first
// - generate JWT with above space Id and given user ID
Parse.Cloud.define("generateAudioJWT", async request => {
  const { userID, vulcanSpaceId, spaceName } = request.params;
  const hifiJWT = await generateAudioJWT(userID, vulcanSpaceId, spaceName);
  return hifiJWT;
});

const generateAudioJWT = async (userID, vulcanSpaceId, spaceName) => {
  let hiFiJWT;
  try {
    const spaceId = await findOrGenerateSpace(vulcanSpaceId, spaceName);

    // - generate JWT with above space Id and given user ID
    const SECRET_KEY_FOR_SIGNING = crypto.createSecretKey(
      Buffer.from(hifiAudioConfig.appSecret, "utf8")
    );
    hiFiJWT = await new SignJWT({
      user_id: userID,
      app_id: hifiAudioConfig.appId,
      space_id: spaceId
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(SECRET_KEY_FOR_SIGNING);

    return hiFiJWT;
  } catch (error) {
    console.error(`Couldn't create JWT! Error:\n${error}`);
    return null;
  }
};

const setupDefaultZones = async (space_id, zonesParams) => {
  try {
    const response = await axios.post(
      `https://api.highfidelity.com/api/v1/spaces/${space_id}/settings/zones?token=${hifiAudioConfig.adminToken}`,
      zonesParams
    );
    if (!response.data || !response.data.length) return null;
    return response.data;
  } catch (e) {
    console.error(
      `https://api.highfidelity.com/api/v1/spaces/${space_id}/settings/zones?token=${hifiAudioConfig.adminToken}`
    );
    throw e;
  }
};
const setupDefaultAttenuations = async (space_id, attsParams) => {
  try {
    const response = await axios.post(
      `https://api.highfidelity.com/api/v1/spaces/${space_id}/settings/zone_attenuations?token=${hifiAudioConfig.adminToken}`,
      attsParams
    );
    if (!response.data || !response.data.length) return null;
    return response.data;
  } catch (e) {
    console.error(e);
    throw e;
  }
};

const GENERAL_ZONE_DIMENSIONS = {
  "x-min": 0,
  "x-max": 1,
  "y-min": 0,
  "y-max": 1,
  "z-min": 2,
  "z-max": 2
};
const MURAL_ZONE_DIMENSIONS = {
  "x-min": 0,
  "x-max": 1000,
  "y-min": 0,
  "y-max": 1000,
  "z-min": 0,
  "z-max": 0
};

Parse.Cloud.define("setupDefaultZones", async request => {
  const { vulcanSpaceId } = request.params;

  const zones = await setupDefaultZones(vulcanSpaceId, [
    {
      name: `${vulcanSpaceId}_mural`,
      ...MURAL_ZONE_DIMENSIONS
    },
    {
      name: `${vulcanSpaceId}_general_channel`,
      ...GENERAL_ZONE_DIMENSIONS
    }
  ]);

  console.log(">> ZONES: ", zones);

  const atts = [
    {
      "source-zone-id": zones[1]["id"], // general channel
      "listener-zone-id": zones[0]["id"], // mural
      attenuation: 0.05, // low attenuation == sound is very audible
      "za-offset": 1
    },
    {
      "source-zone-id": zones[0]["id"], // mural
      "listener-zone-id": zones[1]["id"], // general channel
      attenuation: 0.95,
      "za-offset": 2
    }
  ];

  const attsResult = await setupDefaultAttenuations(vulcanSpaceId, atts);
  console.log(">> ATTS: ", attsResult);

  return attsResult;
});

Parse.Cloud.define("playGeneralZone", async request => {
  const {
    vulcanSpaceId,
    spaceName,
    objectId,
    audioFileName,
    hiFiGain
  } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  const GZD = GENERAL_ZONE_DIMENSIONS;
  await startAudioBox(
    `./music/${audioFileName}.mp3`,
    { x: GZD["x-min"], y: GZD["y-min"], z: GZD["z-min"] },
    hiFiGain,
    hiFiJWT
  );
});

Parse.Cloud.define("stopGeneralZone", async request => {
  const { vulcanSpaceId, spaceName, objectId } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  await stopAudioBox(hiFiJWT);
});

Parse.Cloud.define("startAudioBox", async request => {
  const {
    vulcanSpaceId,
    spaceName,
    objectId,
    audioFileName,
    hiFiGain,
    x,
    y,
    isBroadcast
  } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  await startAudioBox(
    `./music/${audioFileName}.mp3`,
    { x, y, z: 0 },
    hiFiGain,
    hiFiJWT,
    isBroadcast
  );
  // return hifiCommunicator;
});

Parse.Cloud.define("stopAudioBox", async request => {
  const { vulcanSpaceId, spaceName, objectId } = request.params;
  // Generate the JWT used to connect to our High Fidelity Space.
  let hiFiJWT = await generateAudioJWT(objectId, vulcanSpaceId, spaceName);
  if (!hiFiJWT) {
    return;
  }
  await stopAudioBox(hiFiJWT);
});

/**
 * Play the audio from a file into a High Fidelity Space. The audio will loop indefinitely.
 *
 * @param {string} audioPath - Path to an `.mp3` or `.wav` audio file
 * @param {object} position - The {x, y, z} point at which to spatialize the audio.
 * @param {number} hiFiGain - Set above 1 to boost the volume of the bot, or set below 1 to attenuate the volume of the bot.
 */
async function startAudioBox(
  audioPath,
  position,
  hiFiGain,
  hiFiJWT,
  isBroadcast = false
) {
  // Make sure we've been passed an `audioPath`...
  if (!audioPath) {
    console.error(
      `Audio file path not specified! Please specify an audio path with "--audio "`
    );
    return;
  }

  // Make sure the `audioPath` we've been passed is actually a file that exists on the filesystem...
  if (!fs.statSync(audioPath).isFile()) {
    console.error(`Specified path "${audioPath}" is not a file!`);
    return;
  }

  // Make sure that the file at `audioPath` is a `.mp3` or a `.wav` file.
  let audioFileExtension = path.extname(audioPath).toLowerCase();
  if (!(audioFileExtension === ".mp3" || audioFileExtension === ".wav")) {
    console.error(`Specified audio file must be a \`.mp3\` or a \`.wav\`!\
Instead, it's a \`${audioFileExtension}\``);
    return;
  }

  // Read the audio file from our local filesystem into a file buffer.
  const fileBuffer = fs.readFileSync(audioPath),
    // Decode the audio file buffer into an AudioBuffer object.
    audioBuffer = await decode(fileBuffer),
    // Obtain various necessary pieces of information about the audio file.
    { numberOfChannels, sampleRate, length, duration } = audioBuffer,
    // Get the correct format of the `audioBuffer`.
    parsed = format.detect(audioBuffer),
    // Convert the parsed `audioBuffer` into the proper format.
    convertedAudioBuffer = convert(audioBuffer, parsed, "int16"),
    // Define the number of bits per sample encoded into the original audio file. `16` is a commonly-used number. The DJ Bot may malfunction
    // if the audio file specified is encoded using a different number of bits per sample.
    BITS_PER_SAMPLE = 16,
    // Define the interval at which we want to fill the sample data being streamed into the `MediaStream` sent up to the Server.
    // `wrtc` expects this to be 10ms.
    TICK_INTERVAL_MS = 10,
    // There are 1000 milliseconds per second :)
    MS_PER_SEC = 1000,
    // The number of times we fill up the audio buffer per second.
    TICKS_PER_SECOND = MS_PER_SEC / TICK_INTERVAL_MS,
    // The number of audio samples present in the `MediaStream` audio buffer per tick.
    SAMPLES_PER_TICK = sampleRate / TICKS_PER_SECOND,
    // Contains the audio sample data present in the `MediaStream` audio buffer sent to the Server.
    currentSamples = new Int16Array(numberOfChannels * SAMPLES_PER_TICK),
    // Contains all of the data necessary to pass to our `RTCAudioSource()`, which is sent to the Server.
    currentAudioData = {
      samples: currentSamples,
      sampleRate,
      bitsPerSample: BITS_PER_SAMPLE,
      channelCount: numberOfChannels,
      numberOfFrames: SAMPLES_PER_TICK
    },
    // The `MediaStream` sent to the server consists of an "Audio Source" and, within that Source, a single "Audio Track".
    source = new RTCAudioSource(),
    track = source.createTrack(),
    // This is the final `MediaStream` sent to the server. The data within that `MediaStream` will be updated on an interval.
    inputAudioMediaStream = new MediaStream([track]);

  const initData = {
    position: new Point3D(position),
    hiFiGain: hiFiGain
  };

  // set extremely small attanuation effectively making the source to broadcast
  if (isBroadcast) {
    initData.userAttenuation = 0.0000000001;
    initData.userRolloff = 9999999999;
  }

  // Define the initial HiFi Audio API Data used when connecting to the Spatial Audio API.
  const initialHiFiAudioAPIData = new HiFiAudioAPIData(initData),
    // Set up the HiFiCommunicator used to communicate with the Spatial Audio API.
    hifiCommunicator = new HiFiCommunicator({ initialHiFiAudioAPIData });

  // Set the Input Audio Media Stream to the `MediaStream` we created above. We'll fill it up with data below.
  await hifiCommunicator.setInputAudioMediaStream(inputAudioMediaStream);

  // `sampleNumber` defines where we are in the decoded audio stream from above. `0` means "we're at the beginning of the audio file".
  let sampleNumber = 0;
  // Called once every `TICK_INTERVAL_MS` milliseconds.
  let tick = () => {
    // This `for()` loop fills up `currentSamples` with the right amount of raw audio data grabbed from the correct position
    // in the decoded audio file.
    for (
      let frameNumber = 0;
      frameNumber < SAMPLES_PER_TICK;
      frameNumber++, sampleNumber++
    ) {
      for (
        let channelNumber = 0;
        channelNumber < numberOfChannels;
        channelNumber++
      ) {
        currentSamples[frameNumber * numberOfChannels + channelNumber] =
          convertedAudioBuffer[
            sampleNumber * numberOfChannels + channelNumber
          ] || 0;
      }
    }

    // This is the function that actually modifies the `MediaStream` we're sending to the Server.
    source.onData(currentAudioData);

    // Check if we're at the end of our audio file. If so, reset the `sampleNumber` so that we loop.
    if (sampleNumber > length) {
      sampleNumber = 0;
    }
  };

  // Connect to our High Fidelity Space.
  let connectResponse;
  try {
    connectResponse = await hifiCommunicator.connectToHiFiAudioAPIServer(
      hiFiJWT
    );
  } catch (e) {
    console.error(`Call to \`connectToHiFiAudioAPIServer()\` failed! Error:\
${JSON.stringify(e)}`);
    return;
  }

  // Set up the `preciseInterval` used to regularly update the `MediaStream` we're sending to the Server.
  preciseInterval(tick, TICK_INTERVAL_MS);

  console.log(`DJ Bot connected. Let's DANCE!`);
  // return hifiCommunicator;
}

async function stopAudioBox(hiFiJWT) {
  const // Set up the HiFiCommunicator used to communicate with the Spatial Audio API.
    hifiCommunicator = new HiFiCommunicator();

  // Connect to our High Fidelity Space.
  let connectResponse;
  try {
    connectResponse = await hifiCommunicator.connectToHiFiAudioAPIServer(
      hiFiJWT
    );
    await hifiCommunicator.disconnectFromHiFiAudioAPIServer();
  } catch (e) {
    console.error(`Call to \`connectToHiFiAudioAPIServer()\` failed! Error:\
${JSON.stringify(e)}`);
    return;
  }
}

const createAudioRoomObject = async (muralId, widgetId) => {
  const AudioRoom = await Parse.Object.extend(AUDIO_ROOM_MODEL);
  const newRoom = new AudioRoom();
  newRoom.set("widgetId", widgetId);
  newRoom.set("muralId", muralId);
  return newRoom;
};

const registerAudioRoom = async (muralId, widgetId) => {
  try {
    const newRoom = await createAudioRoomObject(muralId, widgetId);
    await newRoom.save();
    return { newRoom };
  } catch (e) {
    console.log("error in registerAudioRoom", e);
  }
};

// TODO: should return a newly generated JWT token
Parse.Cloud.define("registerAudioRoom", async request => {
  const { widgetId, muralId } = request.params;
  const payload = await registerAudioRoom(muralId, widgetId);
  return { payload };
});

Parse.Cloud.define("filterOutAudioRooms", async ({ params }) => {
  const { widgetIds } = params;
  let rooms = [];

  await new Parse.Query(AUDIO_ROOM_MODEL).each(
    async el =>
      widgetIds.includes(await el.get("widgetId")) &&
      rooms.push(await el.toJSON())
  );
  return { rooms };
});

Parse.Cloud.define("removeAudioRoom", async ({ params }) => {
  const { widgetId } = params;

  const roomQuery = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("widgetId", widgetId)
    .first();

  if (roomQuery) {
    roomQuery.destroy();
  }
});
