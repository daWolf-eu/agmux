import os, pty, sys, select, time
argv = sys.argv[1:]
feed = b"\x1b[Ax\x03"  # ESC [ A , 'x', Ctrl-C
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
else:
    time.sleep(0.7)
    os.write(fd, feed)
    out=b""; start=time.time()
    while time.time()-start < 2.0:
        r,_,_=select.select([fd],[],[],0.2)
        if r:
            try: d=os.read(fd,4096)
            except OSError: break
            if not d: break
            out+=d
    try: os.waitpid(pid,0)
    except: pass
    sys.stdout.write(repr(out))
