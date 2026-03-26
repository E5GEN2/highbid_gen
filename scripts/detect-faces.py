#!/usr/bin/env python3
"""
Face detection for smart video cropping.
Uses OpenCV YuNet — handles side profiles, multi-face, CPU-only.

Usage:
  python3 detect-faces.py <video_path> [--start 0] [--end 60] [--fps 5] [--confidence 0.6] [--output faces.json]

Output: JSON with normalized face bounding boxes per sampled frame.
"""

import sys
import json
import argparse
import os
import urllib.request
import cv2

MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
MODEL_PATH = "/tmp/yunet_2023mar.onnx"


def ensure_model():
    """Download YuNet model if not present."""
    if not os.path.exists(MODEL_PATH):
        print("[face-detect] Downloading YuNet model...", file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    return MODEL_PATH


def detect_faces(video_path, start_sec=0, end_sec=None, sample_fps=5, min_confidence=0.6):
    """Run YuNet face detection on sampled frames."""
    model_path = ensure_model()

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    video_fps = cap.get(cv2.CAP_PROP_FPS)
    video_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    video_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames_video = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    video_duration = total_frames_video / video_fps if video_fps > 0 else 0

    if end_sec is None or end_sec > video_duration:
        end_sec = video_duration

    frame_interval = max(1, int(video_fps / sample_fps))
    start_frame = int(start_sec * video_fps)
    end_frame = int(end_sec * video_fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    # Initialize YuNet detector
    detector = cv2.FaceDetectorYN.create(model_path, "", (video_width, video_height), min_confidence)

    frames_data = []
    frame_idx = start_frame
    frames_processed = 0

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
            _, faces_mat = detector.detect(frame)
            faces = []
            if faces_mat is not None:
                for i in range(faces_mat.shape[0]):
                    x, y, fw, fh = faces_mat[i, :4]
                    conf = float(faces_mat[i, -1])
                    faces.append({
                        "x": round(float(x) / video_width, 4),
                        "y": round(float(y) / video_height, 4),
                        "w": round(float(fw) / video_width, 4),
                        "h": round(float(fh) / video_height, 4),
                        "confidence": round(conf, 3),
                    })

            time_sec = round(frame_idx / video_fps, 3)
            frames_data.append({"time": time_sec, "faces": faces})
            frames_processed += 1

            if frames_processed % 100 == 0:
                pct = int((frame_idx - start_frame) / max(1, end_frame - start_frame) * 100)
                print(f"[face-detect] {pct}% ({frames_processed} frames)", file=sys.stderr)

        frame_idx += 1

    cap.release()

    return {
        "detector": "yunet",
        "video_width": video_width,
        "video_height": video_height,
        "video_fps": round(video_fps, 2),
        "fps_sampled": sample_fps,
        "min_confidence": min_confidence,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "total_frames": frames_processed,
        "frames": frames_data,
    }


def main():
    parser = argparse.ArgumentParser(description="Face detection for smart video cropping (YuNet)")
    parser.add_argument("video", help="Path to video file")
    parser.add_argument("--start", type=float, default=0, help="Start time in seconds")
    parser.add_argument("--end", type=float, default=None, help="End time in seconds")
    parser.add_argument("--fps", type=int, default=5, help="Frames per second to sample")
    parser.add_argument("--confidence", type=float, default=0.6, help="Min detection confidence")
    parser.add_argument("--output", "-o", default=None, help="Output JSON file")
    args = parser.parse_args()

    print(f"[face-detect] YuNet detector, conf={args.confidence}, fps={args.fps}", file=sys.stderr)

    result = detect_faces(
        args.video,
        start_sec=args.start,
        end_sec=args.end,
        sample_fps=args.fps,
        min_confidence=args.confidence,
    )

    output = json.dumps(result, separators=(",", ":"))

    if args.output:
        with open(args.output, "w") as f:
            f.write(output)
        faces_count = sum(1 for f in result['frames'] if f['faces'])
        total_det = sum(len(f['faces']) for f in result['frames'])
        print(f"[face-detect] Done: {result['total_frames']} frames, {faces_count} with faces, {total_det} detections", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
