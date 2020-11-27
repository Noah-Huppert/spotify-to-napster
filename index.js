import Spotify from "spotify-web-api-node";
import express from "express";
import cookieParser from "cookie-parser";
import mongodb from "mongodb";

/**
 * Exit process with a message.
 * @param msg {String} To print to stderr when exiting.
 */
function die(msg) {
    console.error(`Error: ${msg}`);
    process.exit(1);
}

/**
 * Spotify OAuth callback endpoint path.
 */
const SPOTIFY_OAUTH_REDIRECT_PATH = "/api/v0/spotify/oauth_callback";

/**
 * Spotify OAuth scopes we require for each user.
 */
const SPOTIFY_OAUTH_SCOPES = [
    // Basic login
    "user-read-private", "user-read-email",

    // Read user playlists
    "playlist-read-private",  "playlist-read-collaborative"
].join(" ");

/**
 * Cookie in which Spotify authentication details are stored.
 */
const SPOTIFY_COOKIE = "spotifyAuth";

/**
 * Wrap an Express endpoint handler and catch any exceptions or promise rejections.
 * @param hndlr {function(req, res, next)} Express handler, doesn't need next.
 * @returns {function(req, res, next)} Wrapped handler which will not throw an error
 *     or reject a promise.
 */
function wrapHandler(hndlr) {
    return async (req, res, next) => {
	    try {
		    // Try running handling
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

/**
 * Retrieve all items from a paginated Spotify endpoint.
 * @param caller {function(offset)} Function which calls the Spotify endpoint from which
 *     you wish to get the paginate results. Should provide the offset argument to the 
 *     API call and return the raw response. This argument allows this function to be
 *     used on any Spotify API endpoint.
 * @returns {Object[]} List of all items.
 */
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

/**
 * Get configuration, connect to the database, and run the API server.
 */
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

    /**
	 * Express middleware which ensures a user is authenticated with Spotify. If they are
	 * not authenticated it returns an error response. If authenticated req.spotify is
	 * set to be an object with the keys: "auth" which holds the authentication cookie and
	 * "client" which holds a Spotify API client for the user.
	 */
    const checkSpotifyAuth = wrapHandler(async (req, res, next) => {
	    // Check auth cookie exists
    	if (req.cookies[SPOTIFY_COOKIE] === undefined) {
		    return res.status(401).send({
			    error: "Not authenticated with Spotify",
		    });
	    }

	    // Ensure auth cookie is valid
	    let auth = JSON.parse(req.cookies[SPOTIFY_COOKIE]);
	    if (auth.scope !== SPOTIFY_OAUTH_SCOPES) {
		    res.cookie(SPOTIFY_COOKIE, "", { maxAge: 0 });
		    return res.status(401).send({
			    error: "Not authenticated with the most recent Spotify scopes",
		    });
	    }

	    let expiresAt = new Date(auth.issuedAt);
	    expiresAt.setSeconds(expiresAt.getSeconds() + auth.expiresIn);
	    if (new Date() >= expiresAt) {
		    res.cookie(SPOTIFY_COOKIE, "", { maxAge: 0 });
		    return res.status(401).send({
			    error: "Authentication expired",
		    });
	    }
	    
	    // Create API client 
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
        let force = req.query.force;
        if (force === undefined) {
            force = false;
        }
        
	    // Sync Spotify user into database
	    const userUpdate = (await db.users.findOneAndUpdate({
		    "spotify.userId": req.spotify.auth.user.id,
	    }, {
		    $set: {
			    spotify: {
				    userId: req.spotify.auth.user.id,
				    user: req.spotify.auth.user,
			    },
		    },
	    }, { upsert: true, returnOriginal: false })).value;

	    // Sync Spotify playlists into database
	    const playlists = (await spotifyPage(async (offset) => {
		    return await req.spotify.client.getUserPlaylists(undefined, {
			    offset: offset
		    });
	    })).filter((playlist) => {
            // We must ignore playlists owned by Spotify because often they end up actually
            // being those radio station playlists.
            return playlist.owner.id !== "spotify"; 
        });
        
        const playlistsWithTracks = (await Promise.all(playlists.map(async (playlist) => {
            // Check we don't already have this playlist's info
            if (force === false) {
                const existingPlaylist = await db.playlists.findOne({
                    "spotify.userId": req.spotify.auth.user.id,
			        "spotify.playlistId": playlist.id,
                });
                
                if (existingPlaylist !== null) {
                    return;
                }
            }

		    // Get tracks for each playlist
		    const tracks = await spotifyPage(async (offset) => {
			    return await req.spotify.client.getPlaylistTracks(playlist.id, {
				    offset: offset,
			    });
		    });

		    // Sync tracks into database
		    const trackUpdates = await Promise.all(tracks.map(async (track) => {
			    return (await db.tracks.findOneAndUpdate({
				    "spotify.trackId": track.track.id,
			    }, {
				    $set: {
				        spotify: {
					        trackId: track.track.id,
					        track: track,
				        },
				    },
			    }, { upsert: true, returnOriginal: false })).value;
            }));

		    // Store list of track database IDs
		    playlist.containsTracks = trackUpdates.map((doc) => {
			    return {
				    _id: doc._id.toString(),
				    trackId: doc.spotify.trackId,
			    };
		    });

            return playlist;
	    }))).filter((playlist) => playlist !== undefined); // If undefined we skipped

	    await Promise.all(playlistsWithTracks.map(async (playlist) => {
		    await db.playlists.updateOne({
			    "spotify.userId": req.spotify.auth.user.id,
			    "spotify.playlistId": playlist.id,
		    }, {
			    $set: {
				    spotify: {
				        userId: req.spotify.auth.user.id,
				        playlistId: playlist.id,
				        playlist: playlist,
				    },
			    },
		    }, { upsert: true });
	    }));

        const usersPlaylists = await db.playlists.find({
			    "spotify.userId": req.spotify.auth.user.id,
		}).toArray();

	    return res.send({
		    user: userUpdate,
		    playlists: usersPlaylists,
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
