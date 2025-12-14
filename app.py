from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import random
import uuid
import os

app = Flask(__name__)
app.secret_key = "super_secret_anniversary_key"

# IMPORTANT: for Render/websockets use eventlet in production
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    ping_interval=25,
    ping_timeout=60,
)

# ---------------- ROUTES ----------------

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/story")
def story():
    return render_template("story.html")

@app.route("/gallery")
def gallery():
    return render_template("gallery.html")

@app.route("/letter")
def letter():
    return render_template("letter.html")

@app.route("/surprise")
def surprise():
    return render_template("surprise.html")

@app.route("/backgammon")
def backgammon():
    return render_template("backgammon.html")


# ---------------- BACKGAMMON MULTIPLAYER ----------------

WAITING = None
GAMES = {}            # room -> state
PLAYER_ROOM = {}      # sid -> room
PLAYER_COLOR = {}     # sid -> "W" or "B"


def opp(c):
    return "B" if c == "W" else "W"


def roll_dice():
    a, b = random.randint(1, 6), random.randint(1, 6)
    return [a, a, a, a] if a == b else [a, b]


def new_game():
    p = [{"W": 0, "B": 0} for _ in range(24)]

    # White
    p[23]["W"] = 2
    p[12]["W"] = 5
    p[7]["W"]  = 3
    p[5]["W"]  = 5

    # Black
    p[0]["B"]  = 2
    p[11]["B"] = 5
    p[16]["B"] = 3
    p[18]["B"] = 5

    return {
        "points": p,
        "bar": {"W": 0, "B": 0},
        "off": {"W": 0, "B": 0},
        "turn": "W",
        "dice": [],
        "dice_left": [],
        "rolled": False,
        "history": []
    }


def snapshot(st):
    return {
        "points": [{"W": x["W"], "B": x["B"]} for x in st["points"]],
        "bar": {"W": st["bar"]["W"], "B": st["bar"]["B"]},
        "off": {"W": st["off"]["W"], "B": st["off"]["B"]},
        "turn": st["turn"],
        "dice": list(st["dice"]),
        "dice_left": list(st["dice_left"]),
        "rolled": st["rolled"],
    }


def restore_from(st, snap):
    st["points"] = [{"W": x["W"], "B": x["B"]} for x in snap["points"]]
    st["bar"] = {"W": snap["bar"]["W"], "B": snap["bar"]["B"]}
    st["off"] = {"W": snap["off"]["W"], "B": snap["off"]["B"]}
    st["turn"] = snap["turn"]
    st["dice"] = list(snap["dice"])
    st["dice_left"] = list(snap["dice_left"])
    st["rolled"] = snap["rolled"]


def is_blocked(color, st, dest):
    return st["points"][dest][opp(color)] >= 2


def dir_step(color):
    return -1 if color == "W" else 1


def entry_point(color, die):
    return (24 - die) if color == "W" else (die - 1)


def home_range(color):
    return range(0, 6) if color == "W" else range(18, 24)


def all_in_home(color, st):
    if st["bar"][color] > 0:
        return False
    for i in range(24):
        if i not in home_range(color) and st["points"][i][color] > 0:
            return False
    return True


def can_bear_off(color, st, src, die):
    if not all_in_home(color, st):
        return False

    if color == "W":
        if src - die == -1:
            return True
        if src - die < 0:
            for i in range(src + 1, 6):
                if st["points"][i][color] > 0:
                    return False
            return True
        return False
    else:
        if src + die == 24:
            return True
        if src + die > 23:
            for i in range(18, src):
                if st["points"][i][color] > 0:
                    return False
            return True
        return False


def legal_targets(color, st, source):
    dice = st["dice_left"]
    if not dice:
        return []

    if st["bar"][color] > 0 and source != "BAR":
        return []

    out = set()
    for die in set(dice):
        if source == "BAR":
            d = entry_point(color, die)
            if 0 <= d <= 23 and not is_blocked(color, st, d):
                out.add(d)
            continue

        if not (isinstance(source, int) and 0 <= source <= 23):
            continue

        if st["points"][source][color] <= 0:
            continue

        dest = source + dir_step(color) * die
        if 0 <= dest <= 23:
            if not is_blocked(color, st, dest):
                out.add(dest)
        else:
            if can_bear_off(color, st, source, die):
                out.add("OFF")

    def key(x):
        return 999 if x == "OFF" else x
    return sorted(out, key=key)


def apply_move(color, st, source, dest):
    if not st["dice_left"]:
        return False, "No dice left. End turn."

    if st["bar"][color] > 0 and source != "BAR":
        return False, "You must enter from the bar first."

    if source != "BAR":
        if not (isinstance(source, int) and 0 <= source <= 23):
            return False, "Bad source."
        if st["points"][source][color] <= 0:
            return False, "No checker there."

    used = None
    dice_unique = sorted(set(st["dice_left"]))

    if source == "BAR":
        if dest == "OFF":
            return False, "Cannot bear off from bar."
        for d in dice_unique:
            if entry_point(color, d) == dest:
                used = d
                break
        if used is None:
            return False, "Illegal entry."
    else:
        for d in dice_unique:
            nd = source + dir_step(color) * d
            if dest != "OFF" and nd == dest:
                used = d
                break
            if dest == "OFF" and can_bear_off(color, st, source, d):
                used = d
                break
        if used is None:
            return False, "Illegal move."

    if dest != "OFF":
        if not (isinstance(dest, int) and 0 <= dest <= 23):
            return False, "Bad destination."
        if is_blocked(color, st, dest):
            return False, "Blocked."

    st["history"].append(snapshot(st))
    if len(st["history"]) > 80:
        st["history"].pop(0)

    if source == "BAR":
        st["bar"][color] -= 1
    else:
        st["points"][source][color] -= 1

    if dest == "OFF":
        st["off"][color] += 1
    else:
        o = opp(color)
        if st["points"][dest][o] == 1:
            st["points"][dest][o] -= 1
            st["bar"][o] += 1
        st["points"][dest][color] += 1

    st["dice_left"].remove(used)
    return True, None


def broadcast(room):
    socketio.emit("bg_state", {"state": GAMES[room]}, room=room)


# ---------------- SOCKET EVENTS ----------------

@socketio.on("disconnect")
def on_disconnect():
    global WAITING
    sid = request.sid

    if WAITING == sid:
        WAITING = None

    PLAYER_ROOM.pop(sid, None)
    PLAYER_COLOR.pop(sid, None)


@socketio.on("bg_join")
def bg_join():
    global WAITING
    sid = request.sid

    if sid in PLAYER_ROOM:
        emit("bg_assigned", {"color": PLAYER_COLOR[sid]}, to=sid)
        broadcast(PLAYER_ROOM[sid])
        return

    if WAITING is None:
        WAITING = sid
        PLAYER_COLOR[sid] = "W"
        emit("bg_assigned", {"color": "W"}, to=sid)
        emit("bg_status", {"msg": "Waiting for opponent…"}, to=sid)
        return

    a = WAITING
    b = sid
    WAITING = None

    room = str(uuid.uuid4())[:8]
    GAMES[room] = new_game()

    PLAYER_ROOM[a] = room
    PLAYER_ROOM[b] = room
    PLAYER_COLOR[a] = "W"
    PLAYER_COLOR[b] = "B"

    socketio.server.enter_room(a, room)
    socketio.server.enter_room(b, room)

    emit("bg_assigned", {"color": "W"}, to=a)
    emit("bg_assigned", {"color": "B"}, to=b)
    socketio.emit("bg_status", {"msg": "Matched ✅"}, room=room)

    broadcast(room)


@socketio.on("bg_roll")
def bg_roll():
    sid = request.sid
    room = PLAYER_ROOM.get(sid)
    if not room:
        return

    st = GAMES[room]
    color = PLAYER_COLOR[sid]

    if st["turn"] != color:
        emit("bg_status", {"msg": "Not your turn."}, to=sid)
        return

    if st["rolled"]:
        emit("bg_status", {"msg": "You already rolled this turn."}, to=sid)
        return

    dice = roll_dice()
    st["dice"] = dice
    st["dice_left"] = dice[:]
    st["rolled"] = True

    broadcast(room)


@socketio.on("bg_select_source")
def bg_select_source(data):
    sid = request.sid
    room = PLAYER_ROOM.get(sid)
    if not room:
        emit("bg_status", {"msg": "Not in a game."}, to=sid)
        return

    st = GAMES[room]
    color = PLAYER_COLOR[sid]

    if st["turn"] != color:
        emit("bg_status", {"msg": "Not your turn."}, to=sid)
        return

    if not st["rolled"]:
        emit("bg_status", {"msg": "Roll dice first."}, to=sid)
        return

    source = data.get("source")
    targets = legal_targets(color, st, source)
    emit("bg_select_result", {"source": source, "targets": targets}, to=sid)


@socketio.on("bg_move")
def bg_move(data):
    sid = request.sid
    room = PLAYER_ROOM.get(sid)
    if not room:
        emit("bg_status", {"msg": "Not in a game."}, to=sid)
        return

    st = GAMES[room]
    color = PLAYER_COLOR[sid]

    if st["turn"] != color:
        emit("bg_status", {"msg": "Not your turn."}, to=sid)
        return

    if not st["rolled"]:
        emit("bg_status", {"msg": "Roll dice first."}, to=sid)
        return

    source = data.get("source")
    dest = data.get("dest")

    ok, err = apply_move(color, st, source, dest)
    if not ok:
        emit("bg_status", {"msg": err}, to=sid)
        return

    if st["off"][color] >= 15:
        socketio.emit("bg_status", {"msg": f"{'White' if color=='W' else 'Black'} wins! 🎉"}, room=room)

    broadcast(room)


@socketio.on("bg_end")
def bg_end():
    sid = request.sid
    room = PLAYER_ROOM.get(sid)
    if not room:
        return

    st = GAMES[room]
    color = PLAYER_COLOR[sid]

    if st["turn"] != color:
        emit("bg_status", {"msg": "Not your turn."}, to=sid)
        return

    st["turn"] = opp(st["turn"])
    st["dice"] = []
    st["dice_left"] = []
    st["rolled"] = False
    broadcast(room)


@socketio.on("bg_undo")
def bg_undo():
    sid = request.sid
    room = PLAYER_ROOM.get(sid)
    if not room:
        return

    st = GAMES[room]
    color = PLAYER_COLOR[sid]

    if st["turn"] != color:
        emit("bg_status", {"msg": "Undo only on your turn."}, to=sid)
        return

    if not st["history"]:
        emit("bg_status", {"msg": "Nothing to undo."}, to=sid)
        return

    snap = st["history"].pop()
    restore_from(st, snap)
    broadcast(room)


# ---------------- RUN ----------------

if __name__ == "__main__":
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5050)),
        debug=False,
        allow_unsafe_werkzeug=True
    )
