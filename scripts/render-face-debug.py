#!/usr/bin/env python3
"""
Render a debug video with face detection bounding boxes overlaid.

Usage:
  python3 render-face-debug.py <video_path> <faces_json> [--output debug.mp4] [--start 0] [--end 60]

Draws green bounding boxes + confidence % on each detected face.
"""

import sys
import json
import argparse
import cv2
import bisect


def main():
    parser = argparse.ArgumentParser(description="Render debug video with face bboxes")
    parser.add_argument("video", help="Path to source video")
    parser.add_argument("faces", help="Path to faces JSON from detect-faces.py")
    parser.add_argument("--output", "-o", default="/tmp/face-debug.mp4", help="Output video path")
    parser.add_argument("--start", type=float, default=0, help="Start time in seconds")
    parser.add_argument("--end", type=float, default=None, help="End time in seconds")
    args = parser.parse_args()

    # Load face data
    with open(args.faces) as f:
        face_data = json.load(f)

    frames_data = face_data["frames"]
    frame_times = [f["time"] for f in frames_data]

    # Open video
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Error: Cannot open {args.video}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps

    start_sec = args.start
    end_sec = args.end if args.end else duration
    start_frame = int(start_sec * fps)
    end_frame = int(end_sec * fps)

    # Output writer — use mp4v codec
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(args.output, fourcc, fps, (width, height))

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    frame_idx = start_frame
    written = 0

    print(f"[render] Video: {width}x{height} @ {fps:.1f}fps, {duration:.1f}s", file=sys.stderr)
    print(f"[render] Rendering {start_sec:.1f}s to {end_sec:.1f}s...", file=sys.stderr)
    print(f"[render] Face data: {len(frames_data)} sampled frames", file=sys.stderr)

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        current_time = frame_idx / fps

        # Find nearest face detection frame
        idx = bisect.bisect_right(frame_times, current_time) - 1
        if idx >= 0 and idx < len(frames_data):
            face_frame = frames_data[idx]
            # Only use if within 0.5s
            if abs(face_frame["time"] - current_time) < 0.5:
                for face in face_frame["faces"]:
                    x = int(face["x"] * width)
                    y = int(face["y"] * height)
                    w = int(face["w"] * width)
                    h = int(face["h"] * height)
                    conf = face.get("confidence", 0)

                    # Green bbox
                    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)

                    # Confidence label
                    label = f"{conf:.0%}"
                    label_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                    cv2.rectangle(frame, (x, y - label_size[1] - 8), (x + label_size[0] + 4, y), (0, 255, 0), -1)
                    cv2.putText(frame, label, (x + 2, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

        # Timestamp overlay
        ts = f"{int(current_time // 60)}:{int(current_time % 60):02d}"
        cv2.putText(frame, ts, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)

        out.write(frame)
        written += 1
        frame_idx += 1

        if written % 500 == 0:
            pct = int((frame_idx - start_frame) / max(1, end_frame - start_frame) * 100)
            print(f"[render] {pct}% ({written} frames)", file=sys.stderr)

    cap.release()
    out.release()
    print(f"[render] Done: {written} frames written to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
