/**
 * From: https://www.w3schools.com/js/js_cookies.asp
 */
function getCookie(cname) {
    var name = cname + "=";
    var decodedCookie = decodeURIComponent(document.cookie);
    var ca = decodedCookie.split(';');
    for(var i = 0; i <ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length);
        }
    }
    
    return null; // Modified to return null if not found
}

// Check if authenticated
const authCont = document.getElementById("auth-container");

const SPOTIFY_COOKIE = "spotifyAuth";
if (getCookie(SPOTIFY_COOKIE) === null) {
    // Not logged into Spotify
    const loginCont = document.createElement("div");
    
    const link = document.createElement("a");
    link.href = "/api/v0/spotify/login";
    link.appendChild(document.createTextNode("Login to Spotify"));

    loginCont.appendChild(link);
    authCont.appendChild(loginCont);
} else {
    // Logged into Spotify
    const cont = document.createElement("div");
    cont.appendChild(document.createTextNode("Succesfully Logged Into Spotify"));
    
    authCont.appendChild(cont);
}
