import os
import glob
from PIL import Image, ImageSequence

personas = ["kratos", "dante", "vergil", "jiraiya", "naruto", "anya"]
artifact_dir = r"C:\Users\Yugi\.gemini\antigravity-ide\brain\16b9dca4-ae95-4110-8003-31a07397dbd6"
output_dir = r"d:\my-council\public\avatars"

# Manually tuned offsets from the top pixel of the character (y_top) to their mouth center
# in the normalized 329x329 canvas (where character height is 270px)
MOUTH_OFFSETS = {
    "kratos": 32,
    "dante": 28,
    "vergil": 28,
    "jiraiya": 32,
    "naruto": 28,
    "anya": 45  # Anya has a larger head
}

def get_base_image(persona):
    pattern = os.path.join(artifact_dir, f"{persona}_base_*.png")
    matches = glob.glob(pattern)
    if not matches:
        return None
    matches.sort(key=os.path.getmtime)
    return matches[-1]

def clean_and_normalize(img_path):
    img = Image.open(img_path).convert("RGBA")
    width, height = img.size
    
    # 1. Key out chroma-key green (#00FF00)
    cleaned = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for y in range(height):
        for x in range(width):
            r, g, b, a = img.getpixel((x, y))
            # Green screen removal heuristic: green channel must be high and dominant
            if g > 120 and g > r + 30 and g > b + 30:
                cleaned.putpixel((x, y), (0, 0, 0, 0))
            else:
                cleaned.putpixel((x, y), (r, g, b, a))
                
    # 2. Extract bounding box of the non-transparent character
    bbox = cleaned.getbbox()
    if not bbox:
        return cleaned
        
    cropped = cleaned.crop(bbox)
    c_w, c_h = cropped.size
    
    # 3. Resize character to exactly 270 pixels tall, maintaining aspect ratio
    target_height = 270
    aspect_ratio = c_w / c_h
    target_width = int(target_height * aspect_ratio)
    
    resized = cropped.resize((target_width, target_height), Image.Resampling.NEAREST)
    
    # 4. Paste centered horizontally and flush against the bottom of a 329x329 canvas
    canvas = Image.new("RGBA", (329, 329), (0, 0, 0, 0))
    paste_x = (329 - target_width) // 2
    paste_y = 329 - target_height
    canvas.paste(resized, (paste_x, paste_y), resized)
    return canvas

def make_mouth_open(img, y_mouth):
    # Copy image and draw a small dark mouth slot at x=163..165, y=y_mouth..y_mouth+1
    mouth_img = img.copy()
    dark_mouth_color = (45, 18, 18, 255) # Dark reddish brown slot
    
    for dy in range(2):
        for dx in range(-1, 2):
            px = 164 + dx
            py = y_mouth + dy
            if 0 <= px < 329 and 0 <= py < 329:
                mouth_img.putpixel((px, py), dark_mouth_color)
    return mouth_img

def compile_assets(persona, base_img):
    print(f"Compiling assets for {persona}...")
    normalized = clean_and_normalize(base_img)
    
    # Save static PNG
    static_path = os.path.join(output_dir, f"{persona}.png")
    normalized.save(static_path)
    print(f"  Saved static PNG: {static_path}")
    
    # Find top pixel on vertical center line to apply mouth offset
    y_top = -1
    for y in range(329):
        _, _, _, a = normalized.getpixel((164, y))
        if a > 0:
            y_top = y
            break
            
    offset = MOUTH_OFFSETS.get(persona, 30)
    y_mouth = y_top + offset
    
    # Generate 4 frames for animations:
    # Frame 0: rest position
    # Frame 1: float up 1px
    # Frame 2: float up 2px
    # Frame 3: float up 1px
    
    frames_think = []
    frames_talk = []
    
    for f in range(4):
        # Calculate Y displacement
        dy = 0
        if f == 1:
            dy = -1
        elif f == 2:
            dy = -2
        elif f == 3:
            dy = -1
            
        # Create displacement frame
        frame_img = Image.new("RGBA", (329, 329), (0, 0, 0, 0))
        frame_img.paste(normalized, (0, dy), normalized)
        frames_think.append(frame_img)
        
        # Add mouth open logic on frames 1 and 3 of talking loop
        if f in [1, 3]:
            # The mouth coordinate needs to match the frame Y offset
            talk_frame = make_mouth_open(normalized, y_mouth)
            talk_displacement = Image.new("RGBA", (329, 329), (0, 0, 0, 0))
            talk_displacement.paste(talk_frame, (0, dy), talk_frame)
            frames_talk.append(talk_displacement)
        else:
            frames_talk.append(frame_img)
            
    # Save thinking GIF
    think_path = os.path.join(output_dir, f"{persona}-thinking.gif")
    frames_think[0].save(
        think_path,
        save_all=True,
        append_images=frames_think[1:],
        loop=0,
        duration=200,
        disposal=2
    )
    print(f"  Saved thinking GIF: {think_path}")
    
    # Save talking GIF
    talk_path = os.path.join(output_dir, f"{persona}-talking.gif")
    frames_talk[0].save(
        talk_path,
        save_all=True,
        append_images=frames_talk[1:],
        loop=0,
        duration=150,
        disposal=2
    )
    print(f"  Saved talking GIF: {talk_path}")

def main():
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    for p in personas:
        base_img = get_base_image(p)
        if not base_img:
            print(f"Error: No base image found for {p}")
            continue
        compile_assets(p, base_img)
    print("All assets compiled successfully!")

if __name__ == "__main__":
    main()
