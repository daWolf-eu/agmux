import os, pty, sys, select, time
# Drive the wrapper under a real PTY with a known window size, capture output.
def main():
    argv = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        # child: set window size on our controlling tty then exec wrapper
        import fcntl, termios, struct
        ws = struct.pack("HHHH", 40, 100, 0, 0)  # rows=40 cols=100
        fcntl.ioctl(0, termios.TIOCSWINSZ, ws)
        os.execvp(argv[0], argv)
    else:
        out = b""
        while True:
            try:
                r,_,_ = select.select([fd],[],[],3)
            except select.error:
                break
            if not r: break
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data: break
            out += data
        os.waitpid(pid, 0)
        sys.stdout.write(out.decode(errors="replace"))
main()
