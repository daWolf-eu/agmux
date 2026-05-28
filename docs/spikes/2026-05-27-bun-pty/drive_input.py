import os, pty, sys, select, time
argv = sys.argv[1:]
# bytes to feed: arrow-up (ESC[A), then Ctrl-C (0x03)
feed = b"\x1b[Atyped\x03"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
else:
    time.sleep(0.6)
    os.write(fd, feed)
    out=b""; start=time.time()
    while time.time()-start < 2.5:
        r,_,_=select.select([fd],[],[],0.3)
        if r:
            try: d=os.read(fd,4096)
            except OSError: break
            if not d: break
            out+=d
    try: os.waitpid(pid,0)
    except: pass
    sys.stdout.write(repr(out))
