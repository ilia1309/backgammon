const socket = io({
    transports: ["websocket"]
});



const cvs = document.getElementById("bgCanvas");
const ctx = cvs.getContext("2d");

/* ================= CONSTANTS ================= */

const BOARD = { x: 32, y: 32, w: 916, h: 576 };
const CENTER_Y = BOARD.y + BOARD.h / 2;
const TRIANGLE_HEIGHT = 240;
const POINT_W = 70;
const BAR_GAP = 90;

/* ================= UI ================= */

const statusEl = document.getElementById("bgStatus");
const youEl = document.getElementById("bgYou");
const turnEl = document.getElementById("bgTurn");
const diceEl = document.getElementById("bgDice");

const rollBtn = document.getElementById("bgRollBtn");
const endBtn = document.getElementById("bgEndBtn");
const undoBtn = document.getElementById("bgUndoBtn");

function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
}

/* ================= STATE ================= */

let state = null;
let myColor = null;
let selectedView = null;
let legalTargetsView = [];
let rollingDice = false;
let rollingValues = [];
let rollAnimFrame = null;


/* ================= MODEL ↔ VIEW ================= */

function modelToView(p) {
    if (p === "BAR" || p === "OFF") return p;
    return myColor === "W" ? p : 23 - p;
}

function viewToModel(p) {
    if (p === "BAR" || p === "OFF") return p;
    return myColor === "W" ? p : 23 - p;
}

/* ================= GEOMETRY ================= */

function geom(v) {
    const top = v >= 12;
    let col = top ? (v - 12) : (11 - v);

    let x = BOARD.x + col * POINT_W;
    if (col >= 6) x += BAR_GAP;

    return { x, top };
}

function hitTest(mx, my) {
    const barX = BOARD.x + 6 * POINT_W;

    if (mx >= barX && mx <= barX + BAR_GAP && my >= BOARD.y && my <= BOARD.y + BOARD.h) {
        return "BAR";
    }

    for (let v = 0; v < 24; v++) {
        const { x, top } = geom(v);
        const y1 = top ? BOARD.y : CENTER_Y + 10;
        const y2 = top ? CENTER_Y - 10 : BOARD.y + BOARD.h;

        if (mx >= x && mx <= x + POINT_W && my >= y1 && my <= y2) return v;
    }
    return null;
}

/* ================= DRAW HELPERS ================= */

function roundRect(x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
}

function drawChecker(x, y, color, selected) {
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fillStyle = color === "W" ? "#fff" : "#111";
    ctx.fill();

    ctx.strokeStyle = color === "W" ? "#0A1A2F" : "#F6E3B4";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (selected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 4;
        ctx.stroke();
    }

    ctx.lineWidth = 1;
}

/* ================= DRAW ================= */

function draw() {
    if (!state || !myColor) return;

    ctx.clearRect(0, 0, cvs.width, cvs.height);

    // frame
    roundRect(12, 12, 956, 616, 22, "#4B2E1E");
    roundRect(20, 20, 940, 600, 18, "#6B3F26");
    roundRect(32, 32, 916, 576, 14, "#F6E3B4");

    // 🔒 CLIP EVERYTHING INSIDE THE BOARD
    ctx.save();
    ctx.beginPath();
    ctx.rect(BOARD.x, BOARD.y, BOARD.w, BOARD.h);
    ctx.clip();


    // bar
    const barX = BOARD.x + 6 * POINT_W;
    ctx.fillStyle = "#0A1A2F";
    ctx.fillRect(barX, BOARD.y + 6, BAR_GAP, BOARD.h - 12);
    ctx.strokeStyle = "#0A1A2F";
    ctx.lineWidth = 3;
    ctx.strokeRect(barX, BOARD.y, BAR_GAP, BOARD.h);

    // triangles
    for (let v = 0; v < 24; v++) {
        const { x, top } = geom(v);

        const baseY = top ? BOARD.y : BOARD.y + BOARD.h;
        const tipY = top
            ? BOARD.y + TRIANGLE_HEIGHT
            : BOARD.y + BOARD.h - TRIANGLE_HEIGHT;


        ctx.fillStyle = (v % 2 === 0) ? "#7A1426" : "#0A1A2F";

        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.lineTo(x + POINT_W, baseY);
        ctx.lineTo(x + POINT_W / 2, tipY);
        ctx.closePath();
        ctx.fill();

        if (legalTargetsView.includes(v)) {
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(x + 6, top ? 36 : CENTER_Y + 14, POINT_W - 12, TRIANGLE_HEIGHT - 20);
            ctx.globalAlpha = 1;
        }

        if (selectedView === v) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 4;
            ctx.strokeRect(x + 6, top ? 36 : CENTER_Y + 14, POINT_W - 12, TRIANGLE_HEIGHT - 20);
            ctx.lineWidth = 1;
        }
    }

    // checkers
    for (let model = 0; model < 24; model++) {
        const stack = state.points[model];
        const color = stack.W > 0 ? "W" : stack.B > 0 ? "B" : null;
        if (!color) continue;

        const count = stack[color];
        const v = modelToView(model);
        const { x, top } = geom(v);
        const cx = x + POINT_W / 2;

        for (let k = 0; k < Math.min(count, 6); k++) {
            const startTop = BOARD.y + 28;
            const startBottom = BOARD.y + BOARD.h - 28;

            const cy = top
                ? startTop + k * 44
                : startBottom - k * 44;

            ctx.beginPath();
            ctx.arc(cx + 2, cy + 2, 22, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.25)";
            ctx.fill();

            drawChecker(cx, cy, color, selectedView === v);
        }
    }

    // ================= DICE VISUALS =================
    if ((rollingDice && rollingValues.length) || (state.dice_left && state.dice_left.length)) {
        const dice = rollingDice ? rollingValues : state.dice_left;

        const DICE_SIZE = 44;
        const GAP = 12;

        const totalWidth = dice.length * DICE_SIZE + (dice.length - 1) * GAP;
        const startX = cvs.width / 2 - totalWidth / 2;
        const y = CENTER_Y - DICE_SIZE / 2;

        dice.forEach((value, i) => {
            drawDie(startX + i * (DICE_SIZE + GAP), y, value);
        });
    }



    // bar checkers
    const bx = barX + BAR_GAP / 2;
    for (let k = 0; k < Math.min(state.bar.W, 6); k++) drawChecker(bx, 120 + k * 44, "W");
    for (let k = 0; k < Math.min(state.bar.B, 6); k++) drawChecker(bx, BOARD.y + BOARD.h - 120 - k * 44, "B");

    youEl.textContent = `You: ${myColor === "W" ? "White" : "Black"}`;
    turnEl.textContent = `Turn: ${state.turn === "W" ? "White" : "Black"}`;
    diceEl.textContent = `Dice: ${state.dice_left?.length ? state.dice_left.join(", ") : "—"}`;

    // 🔓 STOP CLIPPING
    ctx.restore();

}

/* ================= INPUT ================= */

cvs.addEventListener("click", (e) => {
    if (!state || !myColor) return;

    const r = cvs.getBoundingClientRect();
    const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit === null) return;

    if (selectedView === hit) {
        selectedView = null;
        legalTargetsView = [];
        draw();
        return;
    }

    if (selectedView === null) {
        selectedView = hit;
        socket.emit("bg_select_source", { source: viewToModel(hit) });
        return;
    }

    socket.emit("bg_move", {
        source: viewToModel(selectedView),
        dest: viewToModel(hit)
    });

    selectedView = null;
    legalTargetsView = [];
});

function drawDie(x, y, value) {
    const size = 44;
    const r = 8;

    // dice body
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + size, y, x + size, y + size, r);
    ctx.arcTo(x + size, y + size, x, y + size, r);
    ctx.arcTo(x, y + size, x, y, r);
    ctx.arcTo(x, y, x + size, y, r);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#0A1A2F";
    ctx.lineWidth = 2;
    ctx.stroke();

    // dots
    ctx.fillStyle = "#111";
    const d = size / 4;
    const cx = x + size / 2;
    const cy = y + size / 2;

    const dots = {
        1: [[0, 0]],
        2: [[-1, -1], [1, 1]],
        3: [[-1, -1], [0, 0], [1, 1]],
        4: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
        5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
        6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]]
    };

    dots[value].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.arc(cx + dx * d, cy + dy * d, 4, 0, Math.PI * 2);
        ctx.fill();
    });
}


/* ================= SOCKET ================= */

socket.on("connect", () => {
    setStatus("Connected ✅");
    socket.emit("bg_join");
});

socket.on("bg_status", p => setStatus(p.msg));

socket.on("bg_assigned", p => {
    myColor = p.color;
    draw();
});

socket.on("bg_state", (p) => {
    const prevDice = state?.dice_left?.length || 0;
    state = p.state;

    // 🎲 trigger animation only when dice appear
    if (!rollingDice && prevDice === 0 && state.dice_left.length > 0) {
        animateDiceRoll(state.dice_left);
    }

    selectedView = null;
    legalTargetsView = [];
    draw();
});


socket.on("bg_select_result", p => {
    selectedView = modelToView(p.source);
    legalTargetsView = (p.targets || []).map(modelToView);
    draw();
});

rollBtn.onclick = () => {
    socket.emit("bg_roll");
};

endBtn.onclick = () => socket.emit("bg_end");
if (undoBtn) undoBtn.onclick = () => socket.emit("bg_undo");


function animateDiceRoll(finalValues) {
    rollingDice = true;
    let frames = 18; // ~300ms animation

    function tick() {
        rollingValues = finalValues.map(() => Math.floor(Math.random() * 6) + 1);
        draw();

        frames--;
        if (frames > 0) {
            rollAnimFrame = requestAnimationFrame(tick);
        } else {
            rollingDice = false;
            rollingValues = [];
            draw();
        }
    }

    tick();
}
