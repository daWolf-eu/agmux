import os, pty, sys, select, time, fcntl, termios, struct, signal
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    ws = struct.pack("HHHH", 24, 80, 0, 0)
    fcntl.ioctl(0, termios.TIOCSWINSZ, ws)
    os.execvp(argv[0], argv)
else:
    out = b""
    resized = False
    start = time.time()
    while True:
        if not resized and time.time() - start > 1.5:
            ws = struct.pack("HHHH", 60, 200, 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, ws)
            resized = True
        r,_,_ = select.select([fd],[],[],0.3)
        if r:
            try: data = os.read(fd, 4096)
            except OSError: break
            if not data: break
            out += data
        try:
            wpid,_ = os.waitpid(pid, os.WNOHANG)
            if wpid: 
                # drain
                while True:
                    r,_,_=select.select([fd],[],[],0.2)
                    if not r: break
                    try: d=os.read(fd,4096)
                    except OSError: break
                    if not d: break
                    out+=d
                break
        except OSError: break
    sys.stdout.write(out.decode(errors="replace"))
