const AUDIO_ROOM_MODEL = "AudioRoom";
const AUDIO_PERSON = "AudioPerson";
const USERS_AUDIO = "UsersAudio";
const ROOMS_AUDIO = "RoomsAudio";

const createAudioPersonObject = async (
  dolbyId,
  userId,
  muralId,
  widgetId,
  coordinates,
  muted,
  facilitator,
  roomId,
  anchor,
  audioDeviceId,
  videoDeviceId
) => {
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
  newPerson.set("anchor", anchor);
  newPerson.set("audioDeviceId", audioDeviceId);
  newPerson.set("videoDeviceId", videoDeviceId);


  return newPerson;
};

const registerAudioPerson = async (
  dolbyId,
  userId,
  muralId,
  widgetId,
  coordinates,
  muted,
  facilitator,
  roomId,
  anchor,
  audioDeviceId,
  videoDeviceId
) => {
  try {
    const newPerson = await createAudioPersonObject(
      dolbyId,
      userId,
      muralId,
      widgetId,
      coordinates,
      muted,
      facilitator,
      roomId,
      anchor,
      audioDeviceId,
      videoDeviceId
    );
    await newPerson.save();

    return await newPerson;
  } catch (e) {
    console.log("error in registerAudioPerson ", e);
  }
};

Parse.Cloud.define("registerAudioPerson", async ({ params }) => {
  const {
    dolbyId,
    userId,
    muralId,
    widgetId,
    coordinates,
    muted,
    facilitator,
    roomId,
    anchor,
    audioDeviceId,
    videoDeviceId
  } = params;
  const personExists = await new Parse.Query(AUDIO_PERSON)
    .equalTo("userId", userId)
    .find();

  const sameUser = personExists.length
    ? personExists.find(user => user.get("muralId") === muralId)
    : null;

  if (sameUser) {
    sameUser.destroy();
  }
  const audioPerson = await registerAudioPerson(
    dolbyId,
    userId,
    muralId,
    widgetId,
    coordinates,
    muted,
    facilitator,
    roomId,
    anchor,
    audioDeviceId,
    videoDeviceId
  );

  return { audioPerson: audioPerson.toJSON() };
});

Parse.Cloud.define("registerAudioRoom", async ({ params }) => {
  const { widgetId, muralId, width, height, x, y, startStage } = params;

  const AudioRoomExists = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("widgetId", widgetId)
    .first();

  if (AudioRoomExists) {
    await AudioRoomExists.destroy();
  }

  const AudioRoom = await Parse.Object.extend(AUDIO_ROOM_MODEL);

  const newRoom = new AudioRoom();
  newRoom.set("widgetId", widgetId);
  newRoom.set("muralId", muralId);
  newRoom.set("width", width);
  newRoom.set("height", height);
  newRoom.set("x", x);
  newRoom.set("y", y);
  newRoom.set("startStage", startStage);

  return await newRoom.save();
});

Parse.Cloud.define("filterOutAudioRooms", async ({ params }) => {
  const { widgetIds, muralId } = params;
  let rooms = [];
  const allRooms = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();
  if (allRooms.length) {
    allRooms.forEach(
      room =>
        widgetIds.includes(room.get("widgetId")) && rooms.push(room.toJSON())
    );
  }
  return rooms;
});

Parse.Cloud.define("filterOutAudioRoomsId", async ({ params }) => {
  const { muralId } = params;
  let rooms = {};

  const allRooms = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();

  if (allRooms.length) {
    const allRoomsIds = allRooms.map(i => i.get("widgetId"));
    rooms.allRoomsId = allRoomsIds;

    const startStage = allRooms.find(room => room.get("startStage") === true);
    rooms.startRoomId = startStage ? startStage.get("widgetId") : "";
  }

  return rooms;
});

Parse.Cloud.define("setStartingRoom", async ({ params }) => {
  const { muralId, roomId } = params;
  let rooms = [];

  const allRooms = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();

  if (allRooms && allRooms.length) {
    allRooms.find(
      room =>
        room.get("startStage") === true &&
        room.set("startStage", false) &&
        room.save()
    );
    allRooms.find(
      room =>
        room.get("widgetId") === roomId &&
        room.set("startStage", true) &&
        room.save() &&
        rooms.push(room.toJSON())
    );
  }

  return rooms;
});

Parse.Cloud.define("removeAudioRoom", async ({ params }) => {
  const { widgetId, muralId } = params;

  const roomQuery = await new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();

  if (roomQuery.length) {
    roomQuery.forEach(
      room => widgetId === room.get("widgetId") && room.destroy()
    );
  }
});

Parse.Cloud.define("getAudioPersonas", async ({ params }) => {
  const personas = await new Parse.Query(AUDIO_PERSON)
    .equalTo("muralId", params.muralId)
    .find();

  return personas;
});

Parse.Cloud.define("getAudioPerson", async ({ params }) => {
  const person = await new Parse.Query(AUDIO_PERSON)
    .equalTo("userId", params.userId)
    .find();

  return person;
});

const filterAudioRoomsFields = person => ({
  widgetId: person.get("widgetId"),
  muralId: person.get("muralId"),
  active: person.get("active")
});

Parse.Cloud.define("removeAudioPersonas", async ({ params }) => {
  const { userIds, muralId } = params;
  const promiseArray = [];
  for (id of userIds) {
    promiseArray.push(
      new Parse.Query(AUDIO_PERSON).equalTo("userId", id).find()
    );
  }
  const personasQuery = await Promise.all(promiseArray);

  if (personasQuery.length) {
    for (userArray of personasQuery) {
      for (user of userArray) {
        if (muralId === user.get("muralId")) {
          user.destroy();
        }
      }
    }
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
const createRoomsAudioObject = async (
  audioId,
  userId,
  muralId,
  linkToAudio,
  roomId,
  autoplay,
  name,
  loop,
  volume
) => {
  const RoomsAudio = await Parse.Object.extend(ROOMS_AUDIO);
  const newRoomsAudio = new RoomsAudio();

  newRoomsAudio.set("audioId", audioId);
  newRoomsAudio.set("userId", userId);
  newRoomsAudio.set("muralId", muralId);
  newRoomsAudio.set("linkToAudio", linkToAudio);
  newRoomsAudio.set("roomId", roomId);
  newRoomsAudio.set("autoplay", autoplay);
  newRoomsAudio.set("name", name);
  newRoomsAudio.set("loop", loop);
  newRoomsAudio.set("volume", volume);

  return newRoomsAudio;
};

const registerRoomsAudio = async (
  audioId,
  userId,
  muralId,
  linkToAudio,
  roomId,
  autoplay,
  name,
  loop,
  volume
) => {
  try {
    const newAudio = await createRoomsAudioObject(
      audioId,
      userId,
      muralId,
      linkToAudio,
      roomId,
      autoplay,
      name,
      loop,
      volume
    );
    await newAudio.save();

    return newAudio;
  } catch (e) {
    console.log("error in registerRoomsAudio ", e);
  }
};

Parse.Cloud.define("registerRoomsAudio", async ({ params }) => {
  const {
    audioId,
    userId,
    muralId,
    linkToAudio,
    roomId,
    autoplay,
    name,
    loop,
    volume
  } = params;

  const RoomsAudioExists = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("roomId", roomId)
    .first();

  if (RoomsAudioExists) {
    await RoomsAudioExists.destroy();
  }

  const RoomsAudio = await registerRoomsAudio(
    audioId,
    userId,
    muralId,
    linkToAudio,
    roomId,
    autoplay,
    name,
    loop,
    volume
  );
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
    .equalTo("audioId", params.objectId)
    .find();
  if (rooms.length) {
    rooms.forEach(room => room.destroy());
  }
  const audio = await new Parse.Query(USERS_AUDIO)
    .equalTo("objectId", params.objectId)
    .first();
  audio.destroy();

  const fileName = params.linkToAudio.split("/").pop();
  await new Parse.File(fileName).destroy();
  return params;
});

Parse.Cloud.define("removeRoomAudio", async ({ params }) => {
  const rooms = await new Parse.Query(ROOMS_AUDIO)
    .equalTo("objectId", params.objectId)
    .find();
  if (rooms.length) {
    rooms.forEach(room => room.destroy());
  }
  return params;
});

Parse.Cloud.define("getRoomStatistics", async ({ params }) => {
  const { roomId, muralId } = params;
  roomsStat = {
    active: 0,
    empty: 0
  };

  const getRooms = new Parse.Query(AUDIO_ROOM_MODEL)
    .equalTo("muralId", muralId)
    .find();

  const getUsers = new Parse.Query(AUDIO_PERSON)
    .equalTo("muralId", muralId)
    .find();

  const [rooms, users] = await Promise.all([getRooms, getUsers]);

  const usersInRoom = users.filter(i => i.get("roomId") === roomId && i.get("userId"));
  for (const room of rooms) {
    const inRoom = users.filter(i => i.get("roomId") === room.get("widgetId"));
    if (inRoom.length) {
      roomsStat.active++;
    } else {
      roomsStat.empty++;
    }
  }
  return {
    usersInRoomId: usersInRoom.map(i => i.get("userId")),
    activeRooms: roomsStat.active,
    emptyRooms: roomsStat.empty,
    activeUsersId: users.map(i => i.get("userId"))
  };
});