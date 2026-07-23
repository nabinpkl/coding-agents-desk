import logging

from interaction_agent.gesture.runtime import run_gesture_app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(run_gesture_app())


if __name__ == "__main__":
    main()
