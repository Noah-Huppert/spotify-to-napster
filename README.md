# Spotify to Napster
Transfer your Spotify saved tracks and playlists to Napster.

# Table Of Contents
- [Overview](#overview)
- [Use](#use)
- [Development](#development)

# Overview
Transfer all your Spotify saved tracks and playlists to Napster.

It's very silly that at the time of writing this the only option to transfer
your account data is Soundiiz, a payed service. This repository is an open 
source alternative. It is meant to be run locally on your computer.

# Use
NodeJs must be installed.

1. Install dependencies:
   ```
   npm install
   ```
2. Create a Spotify developer app:
   1. Navigate to the [Spotify developer dashboard](https://developer.spotify.com/dashboard/).
   2. Create an app.
   3. Edit its settings and add
      `http://127.0.0.1:8000/api/v0/spotify/oauth_callback` to the
      "Redirect URIs". Note: replace port 8000 with whatever port you run the
      this tool.
3. Configure the tool using the following environment variables:
   - `APP_HTTP_PORT` (Integer): Port the tool's HTTP API will listen. Note: Make
      sure the port you set here matches the port you used in the Spotify API 
      dashboard redirect URI field.
   - `MONGO_URI` (String): Connection URI for MongoDB.
   - `MONGO_DB_NAME` (String): Name of database in MongoDB.
   - `SPOTIFY_CLIENT_ID` (String): Spotify API application client ID.
   - `SPOTIFY_CLIENT_SECRET` (String): Spotify API application client secret.
   - `SPOTIFY_REDIRECT_URI` (String): Location Spotify API will redirect users 
     after completing the OAuth flow. Should match what you set in step 2.
4. Start MongoDB. You can either run your own MongoDB server or use the
   `mongodb` script will start MongoDB in a container (using Podman by default,
   set the `CONTAINER_CLI` environment variable to use a different 
   container tool).
5. Start the tool:
   ```
   npm start
   ```
6. Navigate to the tool's website (Should be running at
   `http://127.0.0.1:APP_HTTP_PORT`, where `APP_HTTP_PORT` is the value you set 
   in step 3).
7. Login to both Spotify and Napster using the tool's web UI.
8. Click the "Transfer" button on the tool's web UI.

# Development
This tool uses NodeJs. User's authenticate with Spotify and Napster using OAuth.

This tool provides an HTTP API which performs the OAuth flows and interacts with
each service.

Data from each service is synced and stored in a MongoDB server.

## MongoDB Data
Generally each data type follows the pattern: Has a `spotify` and `napster` 
field under which service specific data is stored. In these sub-keys fields
named `<data type name>Id` store service specific IDs. Fields named `_id` always
store database IDs.
