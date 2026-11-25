"""Generates the animated GIFs used in README.md (no personal data inside)."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)

W, H = 900, 460
BG = (10, 13, 26)
CARD = (22, 28, 52)
PURPLE = (124, 92, 255)
CYAN = (34, 211, 238)
GOLD = (255, 209, 102)
GREEN = (52, 211, 153)
RED = (251, 113, 133)
WHITE = (238, 241, 255)
MUTED = (152, 161, 200)

try:
    FONT = "C:/Windows/Fonts/arial.ttf"
    TITLE = ImageFont.truetype(FONT, 34)
    HEAD = ImageFont.truetype(FONT, 24)
    BODY = ImageFont.truetype(FONT, 19)
    SMALL = ImageFont.truetype(FONT, 15)
except OSError:
    TITLE = HEAD = BODY = SMALL = ImageFont.load_default()

STEPS = [
    ("1", "Teacher signs in", "Admin panel is password protected", PURPLE),
    ("2", "Students join", "Name + roll number, any device", CYAN),
    ("3", "Question goes live", "Timer starts. Answers stay hidden", GOLD),
    ("4", "Everyone answers", "Admin sees Thinking / Answered", GREEN),
    ("5", "Ranking appears", "After every question, not before", PURPLE),
    ("6", "Final results", "Podium + Excel CSV download", CYAN),
]


def rounded(draw, box, fill, outline=None, radius=16, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def flow_frames():
    frames = []
    for idx, (num, title, sub, accent) in enumerate(STEPS):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)

        d.text((40, 26), "QUIZ ARENA", font=TITLE, fill=WHITE)
        d.text((40, 72), "how a round works", font=BODY, fill=MUTED)

        # Step cards
        x = 40
        for i, (n, t, s, c) in enumerate(STEPS):
            active = i == idx
            fill = CARD if not active else tuple(min(255, v + 18) for v in CARD)
            outline = c if active else (45, 54, 90)
            rounded(d, (x, 130, x + 128, 250), fill, outline, 14, 3 if active else 1)
            d.text((x + 16, 146), n, font=HEAD, fill=c)
            d.text((x + 16, 184), t.split()[0], font=SMALL, fill=WHITE)
            x += 140

        # Big active panel
        rounded(d, (40, 280, 860, 400), CARD, accent, 18, 3)
        d.text((66, 302), f"{num}. {title}", font=HEAD, fill=accent)
        d.text((66, 344), sub, font=BODY, fill=WHITE)

        # Animated progress bar
        bar_w = int(760 * ((idx + 1) / len(STEPS)))
        rounded(d, (66, 380, 66 + bar_w, 388), accent, None, 4)
        d.text((700, 414), f"{idx + 1} / {len(STEPS)}", font=SMALL, fill=MUTED)

        frames.append(img)
    return frames


def engine_frames():
    frames = []
    nodes = [("ADMIN", PURPLE, 60), ("WORKER", CYAN, 350), ("ROOM", GOLD, 640)]
    for phase in range(6):
        img = Image.new("RGB", (W, 300), BG)
        d = ImageDraw.Draw(img)
        d.text((40, 24), "UNDER THE HOOD", font=TITLE, fill=WHITE)
        d.text((40, 70), "one Worker + one Durable Object = one live classroom", font=BODY, fill=MUTED)

        for label, color, x in nodes:
            rounded(d, (x, 130, x + 190, 220), CARD, color, 16, 3)
            d.text((x + 30, 162), label, font=HEAD, fill=color)

        # moving pulse between nodes
        t = (phase % 3) / 2
        px = 250 + int(t * 390)
        d.ellipse((px - 9, 172, px + 9, 190), fill=GREEN)
        rounded(d, (250, 176, px, 180), GREEN, None, 2)
        d.text((60, 250), "question -> answers -> ranking -> next question", font=SMALL, fill=WHITE)
        frames.append(img)
    return frames


def save(name, frames, duration):
    path = OUT / name
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        optimize=True,
    )
    print(path)


save("how-it-works.gif", flow_frames(), 1100)
save("under-the-hood.gif", engine_frames(), 450)
