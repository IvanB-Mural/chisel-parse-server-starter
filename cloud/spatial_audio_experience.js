const { hifiAudioConfig } = require("./common");
const crypto = require("crypto");
const { SignJWT } = require("jose/dist/node/cjs/jwt/sign");

const AUDIO_ROOM_MODEL = "AudioRoom";
const AUDIO_PERSON = "AudioPerson";
const MUTED_USERS = "MutedUsers";
const KICKED_USERS = "KickedUsers";
const SPACE_MAPPING_MODEL = "SpaceMapping";
const USERS_AUDIO = "UsersAudio";
const ROOMS_AUDIO = "RoomsAudio";

Parse.Cloud.define("generateAudioJWT", async request => {
  const { userID, vulcanSpaceId, spaceName } = request.params;
  const hifiJWT = await generateAudioJWT(userID, vulcanSpaceId, spaceName);
  return hifiJWT;
});

const generateAudioJWT = async (userID, vulcanSpaceId, spaceName) => {
  let hiFiJWT;
  try {
   // const spaceId = await findOrGenerateSpace(vulcanSpaceId, spaceName);

    // - generate JWT with above space Id and given user ID
    const SECRET_KEY_FOR_SIGNING = crypto.createSecretKey(
      Buffer.from("JC1eKQRYVxTDppaLG1oMaGfhHTx4DvJyI_mOXfwePZs=", "utf8")
    );
    hiFiJWT = await new SignJWT({
      user_id: userID,
      app_id: vulcanSpaceId,
      space_id: spaceName
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(SECRET_KEY_FOR_SIGNING);

    return hiFiJWT;
  } catch (error) {
    console.error(`Couldn't create JWT! Error:\n${error}`);
    return null;
  }
};

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

// Hifi Spatial Audio Token
// - Check Parse server for existing space token, return if found
// - generate one if doesn't exist,
// - store newly generated one into Parse
const findOrGenerateSpace = async (vulcanSpaceId, name) => {
  try {
    // Find the existing one first.
    const spaceQuery = new Parse.Query(SPACE_MAPPING_MODEL);
    spaceQuery.equalTo("vulcan_space_id", vulcanSpaceId);
    const spaceRecord = await spaceQuery.first({ useMasterKey: true });

    if (!spaceRecord || !spaceRecord.get("space_token")) {
      // When no existing record, generate one.
      const spaceToken = await generateAudioJWT(vulcanSpaceId, name, name);
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

Parse.Cloud.define("findOrGenerateSpace", async request => {
  const { vulcanSpaceId, name } = request.params;
  const spaceToken = await findOrGenerateSpace(vulcanSpaceId, name);
  return spaceToken;
});


const createAudioRoomObject = async (muralId, widgetId) => {
  const AudioRoom = await Parse.Object.extend(AUDIO_ROOM_MODEL);

  const newRoom = new AudioRoom();
  newRoom.set("widgetId", widgetId);
  newRoom.set("muralId", muralId);
  return newRoom;
};


const createAudioPersonObject = async (dolbyId, userId, muralId, widgetId, coordinates, muted, facilitator, roomId) => {
  const AudioPerson = await Parse.Object.extend(AUDIO_PERSON);
  const newPerson = new AudioPerson();
 
  newPerson.set("dolbyId", dolbyId);
  newPerson.set("userId", userId);
  newPerson.set("muralId", muralId);
  newPerson.set("widgetId", widgetId);
  newPerson.set("coordinates", coordinates);
  newPerson.set("muted", muted);
  newPerson.set("facilitator", facilitator);
  newPerson.set("roomId", roomId);

  return newPerson;
};

const createMutedAudioPersonObject = async (muralId, userId, muted) => {
  const MutedAudioPerson = await Parse.Object.extend(MUTED_USERS);
  const newMutedPerson = new MutedAudioPerson();

  newMutedPerson.set("userId", userId);
  newMutedPerson.set("muralId", muralId);
  newMutedPerson.set("muted", muted);

  return newMutedPerson;
};

const registerMutedAudioPerson = async (muralId, userId, muted) => {
  try {
    const newRoom = await createMutedAudioPersonObject(muralId, userId, muted);
    await newRoom.save();
    return newRoom;
  } catch (e) {
    console.log("error in registerMutedAudioPerson ", e);
  }
};

Parse.Cloud.define("registerMutedAudioPerson", async ({ params }) => {
  const { muralId, userId, muted } = params;

  const mutedUserExists = await new Parse.Query(MUTED_USERS)
    .equalTo("userId", userId)
    .first();

  if (!mutedUserExists) {
    const mutedAudioPerson = await registerMutedAudioPerson(muralId, userId, muted);
    return mutedAudioPerson;
  }
});

Parse.Cloud.define("getMutedAudioPersonas", async ({ params }) => {
  const personas = await new Parse.Query(MUTED_USERS)
    .equalTo("muralId", params.muralId)
    .find();

  return personas.map(filterAudioPersonasFields);
});

const createKickedAudioPersonObject = async (muralId, userId, kicked) => {
  const KickedAudioPerson = await Parse.Object.extend(KICKED_USERS);
  const newKickedPerson = new KickedAudioPerson();

  newKickedPerson.set("userId", userId);
  newKickedPerson.set("muralId", muralId);
  newKickedPerson.set("kicked", kicked);

  return newKickedPerson;
};

const registerKickedAudioPerson = async (muralId, userId, kicked) => {
  try {
    const newKickedUser = await createKickedAudioPersonObject(muralId, userId, kicked);
    await newKickedUser.save();
    return newKickedUser;
  } catch (e) {
    console.log("error in registerKickedAudioPerson ", e);
  }
};

Parse.Cloud.define("registerKickedAudioPerson", async ({ params }) => {
  const { muralId, userId, kicked } = params;

  const kickedUserExists = await new Parse.Query(KICKED_USERS)
    .equalTo("userId", userId)
    .first();

  if (!kickedUserExists) {
    const kickedAudioPerson = await registerKickedAudioPerson(muralId, userId, kicked);
    return kickedAudioPerson;
  }
});
const registerAudioRoom = async (muralId, widgetId) => {
  try {
    const newRoom = await createAudioRoomObject(muralId, widgetId);
    await newRoom.save();
    return newRoom;
  } catch (e) {
    console.log("error in registerAudioRoom ", e);
  }
};

Parse.Cloud.define("registerAudioRoom", async ({ params }) => {
  const { widgetId, muralId, muralName } = params;
  const room = await registerAudioRoom(muralId, widgetId, muralName);

  return {
    payload: {
      widgetId: room.get("widgetId"),
      muralId: room.get("muralId"),
    }
  };
});

Parse.Cloud.define("defineActiveAudioRoom", async ({ params }) => {
  const { widgetId } = params;

  const roomExists = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("widgetId", widgetId).find();

    if (roomExists.length) {
      roomExists.forEach(
        room => widgetId.includes(room.get("widgetId")) && room.set("active", true) && room.save()
      );
    }
    return roomExists;
});

Parse.Cloud.define("defineEmptyAudioRoom", async ({ params }) => {
  const { widgetId } = params;

  const roomExists = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("widgetId", widgetId).find();

    if (roomExists.length) {
      roomExists.forEach(
        room => widgetId.includes(room.get("widgetId")) && room.set("active", false) && room.save()
      );
    }
    return roomExists;
});


const registerAudioPerson = async (dolbyId, userId, muralId, widgetId, coordinates, muted, facilitator, roomId) => {
  try {
    const newPerson = await createAudioPersonObject(dolbyId, userId, muralId, widgetId, coordinates, muted, facilitator, roomId);
    await newPerson.save();

    return await newPerson;
  } catch (e) {
    console.log("error in registerAudioPerson ", e);
  }
};

Parse.Cloud.define("registerAudioPerson", async ({ params }) => {
  const { dolbyId, userId, muralId, widgetId, coordinates, muted, facilitator, roomId } = params;
  const personExists = await new Parse.Query(AUDIO_PERSON)
    .equalTo("userId", userId)
    .first();

  if (personExists) {
    personExists.destroy();
  }
  const audioPerson = await registerAudioPerson(dolbyId, userId, muralId, widgetId, coordinates, muted, facilitator, roomId);
  return { audioPerson: audioPerson.toJSON() };
});

Parse.Cloud.define("updateAudioPersonRoomId", async ({ params }) => {
  const { widgetId, roomId } = params;

  const userExists = await new Parse.Query(AUDIO_PERSON)
    .equalTo("widgetId", widgetId).find();

    if (userExists.length) {
      userExists.forEach(
        user => widgetId.includes(user.get("widgetId")) && user.set("roomId", roomId) && user.save()
      );
    }
    return userExists;
});

Parse.Cloud.define("updateAudioPersonDolbyId", async ({ params }) => {
  const { widgetId, dolbyUserId } = params;

  const userExists = await new Parse.Query(AUDIO_PERSON)
    .equalTo("widgetId", widgetId).find();

    if (userExists.length) {
      userExists.forEach(
        user => widgetId.includes(user.get("widgetId")) && user.set("dolbyUserId", dolbyUserId) && user.save()
      );
    }
    return userExists;
});

const filterAudioPersonasFields = person => ({
  roomId: person.get("roomId"),
  dolbyUserId: person.get("dolbyUserId"),
  userId: person.get("userId"),
  muralId: person.get("muralId"),
  widgetId: person.get("widgetId"),
});

// -----------CLOUD-----------------------------------------------------------------------------------------------------

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

Parse.Cloud.define("removeAudioRooms", async ({ params }) => {
  const { widgetIds, muralId } = params;

  const roomQuery = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();

  if (roomQuery.length) {
    roomQuery.forEach(
      room => widgetIds.includes(room.get("widgetId")) && room.destroy()
    );
  }
});

Parse.Cloud.define("getAudioPersonas", async ({ params }) => {
  const personas = await new Parse.Query(AUDIO_PERSON)
    .equalTo("muralId", params.muralId)
    .find();

  return personas.map(filterAudioPersonasFields);
});

Parse.Cloud.define("getAudioPersonasByRoom", async ({ params }) => {
  const personas = await new Parse.Query(AUDIO_PERSON)
    .equalTo("roomId", params.roomId)
    .find();

  return personas.map(filterAudioPersonasFields);
});

Parse.Cloud.define("getAudioPerson", async ({ params }) => {
  const person = await new Parse.Query(AUDIO_PERSON)
    .equalTo("widgetId", params.widgetId)
    .find();

  return person;
});

const filterAudioRoomsFields = person => ({
  widgetId: person.get("widgetId"),
  muralId: person.get("muralId"),
  active: person.get("active"),
});

Parse.Cloud.define("getAudioRooms", async ({ params }) => {
  const rooms = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", params.muralId)
    .find();

  return rooms.map(filterAudioRoomsFields);
});

Parse.Cloud.define("removeAudioPersonas", async ({ params }) => {
  const { userIds, muralId } = params;
  const promiseArray = [];
  for (id of userIds) {
    promiseArray.push(new Parse.Query(AUDIO_PERSON)
    .equalTo("userId", id)
    .find());
  }
  const personasQuery = await Promise.all(promiseArray)

  if (personasQuery.length) {
    for (userArray of personasQuery) {
      for (user of userArray) {
        user.destroy()
      }
    }
    
  }
});

Parse.Cloud.define("removeMutedAudioPersonas", async ({ params }) => {
  const { muralId, userIds } = params;

  const personasQuery = await new Parse.Query(MUTED_USERS)
    .equalTo("muralId", muralId)
    .find();

  if (personasQuery.length) {
    personasQuery.forEach(
      person => userIds.includes(person.get("userId")) && person.destroy()
    );
  }
});

//Users audio
const createUsersAudioObject = async (userId, linkToAudio, name) => {
  const UsersAudio = await Parse.Object.extend(USERS_AUDIO);
  const newUsersAudio = new UsersAudio();

  newUsersAudio.set("userId", userId);
  newUsersAudio.set("linkToAudio", linkToAudio);
  newUsersAudio.set("name", name);

  return newUsersAudio;
};

const registerUsersAudio = async (userId, linkToAudio, name) => {
  try {
    const newAudio = await createUsersAudioObject(userId, linkToAudio, name);
    await newAudio.save();
    return newAudio;
  } catch (e) {
    console.log("error in registerUsersAudio ", e);
  }
};

Parse.Cloud.define("registerUsersAudio", async ({ params }) => {
  const { userId, linkToAudio, name } = params;

  const UsersAudio = await registerUsersAudio(userId, linkToAudio, name);
  return UsersAudio;
});

Parse.Cloud.define("getUsersAudio", async ({ params }) => {
  const personas = await new Parse.Query(USERS_AUDIO)
    .equalTo("userId", params.userId)
    .find();

  return personas;
});

//Rooms audio 
const createRoomsAudioObject = async (audioId, userId, muralId, linkToAudio, roomId, autoplay, name) => {
  const RoomsAudio = await Parse.Object.extend(ROOMS_AUDIO);
  const newRoomsAudio = new RoomsAudio();

  newRoomsAudio.set("audioId", audioId);
  newRoomsAudio.set("userId", userId);
  newRoomsAudio.set("muralId", muralId);
  newRoomsAudio.set("linkToAudio", linkToAudio);
  newRoomsAudio.set("roomId", roomId);
  newRoomsAudio.set("autoplay", autoplay);
  newRoomsAudio.set("name", name);

  return newRoomsAudio;
};

const registerRoomsAudio = async (audioId, userId, muralId, linkToAudio, roomId, autoplay, name) => {
  try {
    const newAudio = await createRoomsAudioObject(audioId, userId, muralId, linkToAudio, roomId, autoplay, name);
    await newAudio.save();

    return newAudio;
  } catch (e) {
    console.log("error in registerRoomsAudio ", e);
  }
};

Parse.Cloud.define("registerRoomsAudio", async ({ params }) => {
  const { audioId, userId, muralId, linkToAudio, roomId, autoplay, name } = params;

  const RoomsAudioExists = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("roomId", roomId)
    .first();

  if (RoomsAudioExists) {
    await RoomsAudioExists.destroy();
  }
  const RoomsAudio = await registerRoomsAudio(audioId, userId, muralId, linkToAudio, roomId, autoplay, name);
  return RoomsAudio;
});

Parse.Cloud.define("getRoomsAudio", async ({ params }) => {
  const roomAudio = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("roomId", params.roomId)
    .find();

  return roomAudio;
});

Parse.Cloud.define("removeUserAudio", async ({ params }) => {
  
  const rooms = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("audioId", params.audioId)
    .find();
  if (rooms.length) {
    rooms.forEach(
      room => room.destroy()
    );
  }
  const audio = await new Parse.Query(USERS_AUDIO)
    .equalTo("objectId", params.audioId)
    .first();
  audio.destroy();

  const fileName = params.linkToAudio.split('/').pop();
  await new Parse.File(fileName).destroy();
  return params;
});

Parse.Cloud.define("removeRoomAudio", async ({ params }) => {
  
  const rooms = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("objectId", params.objectId)
    .find();
  if (rooms.length) {
    rooms.forEach(
      room => room.destroy()
    );
  }
  return params;
});
