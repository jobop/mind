"""Read only task counts before a deployment restart; never print task input or credentials."""
import os, sqlite3, sys, time

def active_jobs(path):
    if not os.path.exists(path):
        return 0
    with sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=5) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_jobs'").fetchone():
            return 0
        return db.execute("SELECT count(*) FROM generation_jobs WHERE status IN ('queued','running')").fetchone()[0]

def main():
    path = sys.argv[1]
    deadline = time.monotonic() + 1260
    while True:
        count = active_jobs(path)
        if not count:
            print('No active generation jobs; proceeding with deployment.', flush=True)
            return
        if time.monotonic() >= deadline:
            raise SystemExit('Generation jobs are still active. Leaving the running application unchanged; deploy again when idle.')
        print('Waiting for %d active generation job(s) before restart.' % count, flush=True)
        time.sleep(10)

if __name__ == '__main__':
    main()
