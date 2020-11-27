import Spotify from "spotify-web-api-node";
import express from "express";
import cookieParser from "cookie-parser";
import mongodb from "mongodb";

function die(msg) {
    console.error(`Error: ${msg}`);
    process.exit(1);
}

const SPOTIFY_OAUTH_REDIRECT_PATH = "/api/v0/spotify/oauth_callback";
const SPOTIFY_OAUTH_SCOPES = [
    // Basic login
    "user-read-private", "user-read-email",

    // Read user playlists
    "playlist-read-private",  "playlist-read-collaborative"
].join(" ");
const SPOTIFY_COOKIE = "spotifyAuth";

function wrapHandler(hndlr) {
    return async (req, res, next) => {
	   try {
		  await hndlr(req, res, next);
	   } catch (e) {
		  // Try to send an error message
		  console.error(`Exception in ${req.method} ${req.path}`, e);
		  
		  if (res.finished !== true) {
			 return res.status(500).send({
				error: "Internal server error",
			 });
		  }

		  return;
	   }
    };
}

async function spotifyPage(caller) {
    let items = [];
    let total = -1;

    while (total === -1 || items.length < total) {
	   let offset = items.length;
	   if (offset > 0) {
		  offset -= 1;
	   }

	   const resp = (await caller(offset)).body;
	   
	   total = resp.total;

	   resp.items.forEach((item) => items.push(item));
    }
    
    return items;
}

async function main() {
    // Get configuration
    let missingEnvs = new Set();
    function getEnv(name) {
	   if (process.env[name] === undefined) {
		  missingEnvs.add(name);
	   }

	   return process.env[name];
    }

    const cfg = {
	   http: {
		  port: getEnv("APP_HTTP_PORT"),
	   },
	   mongodb: {
		  uri: getEnv("MONGO_URI"),
		  dbName: getEnv("MONGO_DB_NAME"),
	   },
	   spotify: {
		  clientId: getEnv("SPOTIFY_CLIENT_ID"),
		  clientSecret: getEnv("SPOTIFY_CLIENT_SECRET"),
		  redirectUri: getEnv("SPOTIFY_REDIRECT_URI"),
	   },
    };

    if (missingEnvs.size > 0) {
	   throw `missing configuration environment variable(s): ${Array.from(missingEnvs).join(', ')}`;
    }

    if (cfg.spotify.redirectUri.indexOf(SPOTIFY_OAUTH_REDIRECT_PATH) === -1) {
	   throw `Spotify OAuth redirect URI must point to ${SPOTIFY_OAUTH_REDIRECT_PATH}`;
    }

    // Mongo DB
    const dbConn = await mongodb.MongoClient.connect(cfg.mongodb.uri, {
	   useUnifiedTopology: true
    });
    const dbClient = await dbConn.db(cfg.mongodb.dbName);

    const db = {
	   users: await dbClient.collection("users"),
	   playlists: await dbClient.collection("playlists"),
	   tracks: await dbClient.collection("tracks"),
    };

    console.log("Connected to MongoDB");
    
    // Spotify API
    const spotifyClient = new Spotify(cfg.spotify);

    // Web API
    const app = express();
    app.use(cookieParser());
    app.use(express.static("./public"));

    const checkSpotifyAuth = wrapHandler(async (req, res, next) => {
    	   if (req.cookies[SPOTIFY_COOKIE] === undefined) {
		  return res.status(401).send({
			 error: "Not authenticated with Spotify",
		  });
	   }
	   
	   let auth = JSON.parse(req.cookies[SPOTIFY_COOKIE]);
	   if (auth.scope !== SPOTIFY_OAUTH_SCOPES) {
		  res.cookie(SPOTIFY_COOKIE, "", { expires: Date.now() });
		  return res.status(401).send({
			 error: "Not authenticated with the most recent Spotify scopes",
		  });
	   }

	   let client = new Spotify(cfg.spotify);
	   client.setAccessToken(auth.accessToken);
	   client.setRefreshToken(auth.refreshToken);

	   req.spotify = {
		  auth: auth,
		  client: client,
	   };

	   next();
    });

    app.get("/", wrapHandler((req, res) => {
	   const query = Object.keys(req.query).map((k) => {
		  return `${k}=${encodeURIComponent(v)}`;
	   }).join("&");
	   return res.redirect(`/index.html?${query}`);
    }));

    app.get('/api/v0/spotify/login', wrapHandler((req, res) => {
	   let from = req.query.from;
	   if (from === undefined) {
		  from = "";
	   }
	   return res.redirect(`https://accounts.spotify.com/authorize?\
response_type=code&\
client_id=${cfg.spotify.clientId}&\
scope=${encodeURIComponent(SPOTIFY_OAUTH_SCOPES)}&\
redirect_uri=${encodeURIComponent(cfg.spotify.redirectUri)}&\
state=${from}`);
    }));

    app.get(SPOTIFY_OAUTH_REDIRECT_PATH, wrapHandler(async (req, res) => {
	   let from = req.query.state;
	   if (from === "") {
		  from = "/";
	   }
	   
	   if (req.query.error !== undefined) {
		  console.error(`Spotify API error: ${req.query.error}`);
		  return res.redirect(`${from}?spotifyOAuth=fail`);
	   }

	   let spotifyAuth = await spotifyClient.authorizationCodeGrant(req.query.code);

	   
	   let client = new Spotify(cfg.spotify);
	   client.setAccessToken(spotifyAuth.body["access_token"]);
	   client.setRefreshToken(spotifyAuth.body["refresh_token"]);

	   let user = (await client.getMe()).body;
	   
	   res.cookie(SPOTIFY_COOKIE, JSON.stringify({
		  accessToken: spotifyAuth.body["access_token"],
		  refreshToken: spotifyAuth.body["refresh_token"],
		  issuedAt: new Date(),
		  expiresIn: spotifyAuth.body["expires_in"],
		  scope: SPOTIFY_OAUTH_SCOPES,
		  user: user,
	   }));

	   return res.redirect(`${from}?spotifyOAuth=success`);
    }));

    app.get("/api/v0/spotify/sync", checkSpotifyAuth, wrapHandler(async (req, res) => {
	   // Sync Spotify user into database
	   const userUpdate = (await db.users.findOneAndUpdate({
		  spotify: {
			 userId: req.spotify.auth.user.id,
		  },
	   }, {
		  $set: {
			 spotify: {
				userId: req.spotify.auth.user.id,
				user: req.spotify.auth.user,
			 },
		  },
	   }, { upsert: true })).value;

	   // Sync Spotify playlists into database
	   const playlists = (await spotifyPage(async (offset) => {
		  return await req.spotify.client.getUserPlaylists(undefined, {
			 offset: offset
		  });
	   })).map(async (playlist) => {
		  // Get tracks for each playlist
		  const tracks = await spotifyPage(async (offset) => {
			 return await req.spotify.client.getPlaylistTracks({
				offset: offset,
			 });
		  });

		  // Sync tracks into database
		  const trackUpdates = await Promise.all(tracks.map(async (track) => {
			 return (await db.spotifyTracks.findOneAndUpdate({
				spotify: {
				    trackId: track.id,
				},
			 }, {
				$set: {
				    spotify: {
					   trackId: trackId,
					   track: track,
				    },
				},
			 }, { upsert: true })).value;
		  }));

		  // Store list of track database IDs
		  playlist.containsTracks = trackUpdates.map((doc) => {
			 return {
				_id: doc._id.toString(),
				trackId: doc.spotify.trackId,
			 };
		  });
	   });

	   const playlistUpdates = await Promise.all(playlists.map(async (playlist) => {
		  return (await db.spotifyPlaylists.findOneAndUpdate({
			 spotify: {
				userId: req.spotify.auth.user.id,
				playerlistId: playlist.id,
			 },
		  }, {
			 $set: {
				spotify: {
				    userId: req.spotify.auth.user.id,
				    playerlistId: playlist.id,
				    playlist: playlist,
				},
			 },
		  }, { upsert: true })).value;
	   }));
	   
	   return res.send({
		  user: userUpdate,
		  playlists: playlistUpdates,
	   });
    }));

    return new Promise((resolve, reject) => {
	   const server = app.listen(cfg.http.port, () => {
		  console.log(`HTTP API listening on :${cfg.http.port}`);
	   });

	   process.on("SIGINT", async () => {
		  console.log("Shutting down");
		  server.close();
		  await dbConn.close();
	   });
	   
	   server.on("error", (e) => {
		  reject(e);
	   });

	   server.on("close", () => {
		  resolve();
	   });
    });
}

main()
    .then(() => console.log("Done"))
    .catch((e) => die(e));
