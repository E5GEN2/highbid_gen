#!/usr/bin/env python3
"""
Face detection for smart video cropping.
Uses MediaPipe Face Detection (CPU-only).

Usage:
  python3 detect-faces.py <video_path> [--start 0] [--end 60] [--fps 5] [--output faces.json]

Output: JSON with normalized face bounding boxes per sampled frame.
"""

import sys
import json
import argparse
import cv2
import numpy as np

# MediaPipe imports — handle both old (solutions) and new (tasks) API
try:
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import FaceDetector, FaceDetectorOptions
    USE_TASKS_API = True
except ImportError:
    try:
        import mediapipe as mp
        USE_TASKS_API = False
    except ImportError:
        print("Error: mediapipe not installed", file=sys.stderr)
        sys.exit(1)


def get_model_path():
    """Find MediaPipe face detection model."""
    import os
    # The tasks API needs a .tflite model file
    # Try common locations
    candidates = [
        os.path.join(os.path.dirname(__file__), 'blaze_face_short_range.tflite'),
        '/tmp/blaze_face_short_range.tflite',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p

    # Download it
    import urllib.request
    model_url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
    dest = '/tmp/blaze_face_short_range.tflite'
    print(f"[face-detect] Downloading model...", file=sys.stderr)
    urllib.request.urlretrieve(model_url, dest)
    return dest


def detect_faces_tasks_api(video_path, start_sec=0, end_sec=None, sample_fps=5, min_confidence=0.5):
    """Face detection using MediaPipe Tasks API (v0.10+)."""
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

    # Initialize face detector
    model_path = get_model_path()
    options = FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        min_detection_confidence=min_confidence,
    )
    detector = FaceDetector.create_from_options(options)

    frames_data = []
    frame_idx = start_frame
    frames_processed = 0

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            results = detector.detect(mp_image)

            faces = []
            for det in results.detections:
                bbox = det.bounding_box
                faces.append({
                    "x": round(bbox.origin_x / video_width, 4),
                    "y": round(bbox.origin_y / video_height, 4),
                    "w": round(bbox.width / video_width, 4),
                    "h": round(bbox.height / video_height, 4),
                    "confidence": round(det.categories[0].score, 3) if det.categories else 0.5,
                })

            time_sec = round(frame_idx / video_fps, 3)
            frames_data.append({"time": time_sec, "faces": faces})
            frames_processed += 1

            if frames_processed % 50 == 0:
                pct = int((frame_idx - start_frame) / max(1, end_frame - start_frame) * 100)
                print(f"[face-detect] {pct}% ({frames_processed} frames)", file=sys.stderr)

        frame_idx += 1

    cap.release()

    return {
        "video_width": video_width,
        "video_height": video_height,
        "video_fps": round(video_fps, 2),
        "fps_sampled": sample_fps,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "total_frames": frames_processed,
        "frames": frames_data,
    }


def detect_faces_solutions_api(video_path, start_sec=0, end_sec=None, sample_fps=5, min_confidence=0.5):
    """Face detection using legacy MediaPipe Solutions API."""
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

    mp_face = mp.solutions.face_detection
    face_detection = mp_face.FaceDetection(
        model_selection=1,
        min_detection_confidence=min_confidence,
    )

    frames_data = []
    frame_idx = start_frame
    frames_processed = 0

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_detection.process(rgb)

            faces = []
            if results.detections:
                for det in results.detections:
                    bbox = det.location_data.relative_bounding_box
                    faces.append({
                        "x": round(bbox.xmin, 4),
                        "y": round(bbox.ymin, 4),
                        "w": round(bbox.width, 4),
                        "h": round(bbox.height, 4),
                        "confidence": round(det.score[0], 3),
                    })

            time_sec = round(frame_idx / video_fps, 3)
            frames_data.append({"time": time_sec, "faces": faces})
            frames_processed += 1

            if frames_processed % 50 == 0:
                pct = int((frame_idx - start_frame) / max(1, end_frame - start_frame) * 100)
                print(f"[face-detect] {pct}% ({frames_processed} frames)", file=sys.stderr)

        frame_idx += 1

    cap.release()
    face_detection.close()

    return {
        "video_width": video_width,
        "video_height": video_height,
        "video_fps": round(video_fps, 2),
        "fps_sampled": sample_fps,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "total_frames": frames_processed,
        "frames": frames_data,
    }


def main():
    parser = argparse.ArgumentParser(description="Face detection for smart video cropping")
    parser.add_argument("video", help="Path to video file")
    parser.add_argument("--start", type=float, default=0, help="Start time in seconds")
    parser.add_argument("--end", type=float, default=None, help="End time in seconds")
    parser.add_argument("--fps", type=int, default=5, help="Frames per second to sample")
    parser.add_argument("--confidence", type=float, default=0.5, help="Min detection confidence")
    parser.add_argument("--output", "-o", default=None, help="Output JSON file")
    args = parser.parse_args()

    detect_fn = detect_faces_tasks_api if USE_TASKS_API else detect_faces_solutions_api
    print(f"[face-detect] Using {'Tasks' if USE_TASKS_API else 'Solutions'} API", file=sys.stderr)

    result = detect_fn(
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
        print(f"[face-detect] Done: {result['total_frames']} frames, {faces_count} with faces", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
