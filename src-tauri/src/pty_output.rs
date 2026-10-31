//! Coalesce short Unix PTY reads that are already available. Never wait to fill
//! a batch: a prompt or TUI response still leaves on its first read.
use portable_pty::MasterPty;
use std::io::{self, Read};
#[cfg(unix)]
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
const BATCH_BYTES: usize = 8 * 1024;
#[cfg(unix)]
const DRAIN_BUDGET: Duration = Duration::from_micros(250);

pub struct PtyOutputReader {
    reader: Box<dyn Read + Send>,
    #[cfg(unix)]
    readiness: Option<OwnedFd>,
}

impl PtyOutputReader {
    pub fn new(reader: Box<dyn Read + Send>, master: &dyn MasterPty) -> Self {
        #[cfg(unix)]
        let readiness = master.as_raw_fd().and_then(|fd| {
            // SAFETY: master owns this valid fd for the duration of this call.
            // Keep our own duplicate so kill/descriptor reuse cannot race poll.
            unsafe { BorrowedFd::borrow_raw(fd) }
                .try_clone_to_owned()
                .ok()
        });
        #[cfg(not(unix))]
        let _ = master;
        Self {
            reader,
            #[cfg(unix)]
            readiness,
        }
    }

    #[cfg(unix)]
    fn read_batch(&mut self, output: &mut [u8], budget: Duration) -> io::Result<usize> {
        let limit = output.len().min(BATCH_BYTES);
        // The first read retains the normal blocking semantics. Only subsequent
        // reads use readiness, and no other thread consumes this PTY's output.
        let mut total = self.reader.read(&mut output[..limit])?;
        let start = Instant::now();
        while total > 0 && total < limit && start.elapsed() < budget {
            let Some(fd) = self.readiness.as_ref() else {
                break;
            };
            let mut poll = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll points to one initialized pollfd and OwnedFd keeps
            // its descriptor alive. Timeout zero never waits for future bytes.
            if unsafe { libc::poll(&mut poll, 1, 0) } <= 0 || poll.revents & libc::POLLIN == 0 {
                break;
            }
            match self.reader.read(&mut output[total..limit]) {
                Ok(0) | Err(_) => break, // deliver bytes already read before EOF/error
                Ok(n) => total += n,
            }
        }
        Ok(total)
    }
}

impl Read for PtyOutputReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        #[cfg(unix)]
        {
            self.read_batch(output, DRAIN_BUDGET)
        }
        // ConPTY already supplies larger reads. Preserve its original size and
        // behaviour rather than increasing Windows IPC traffic to 8 KiB units.
        #[cfg(not(unix))]
        {
            self.reader.read(output)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsFd;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;

    struct ShortReader(UnixStream);
    impl Read for ShortReader {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let limit = output.len().min(1024);
            self.0.read(&mut output[..limit])
        }
    }

    fn pair() -> (PtyOutputReader, UnixStream) {
        let (reader, writer) = UnixStream::pair().unwrap();
        let readiness = Some(reader.as_fd().try_clone_to_owned().unwrap());
        (
            PtyOutputReader {
                reader: Box::new(ShortReader(reader)),
                readiness,
            },
            writer,
        )
    }

    #[test]
    fn drains_available_short_reads_up_to_byte_limit_without_losing_tail() {
        let (mut reader, mut writer) = pair();
        let data = "Tiếng Việt 中 🚀".repeat(1000).into_bytes();
        writer.write_all(&data[..BATCH_BYTES]).unwrap();
        let outgoing = data[BATCH_BYTES..].to_vec();
        let writer = std::thread::spawn(move || writer.write_all(&outgoing).unwrap());
        let mut buffer = [0; 65536];
        let n = reader.read_batch(&mut buffer, Duration::MAX).unwrap();
        assert_eq!(n, BATCH_BYTES);
        let mut received = buffer[..n].to_vec();
        loop {
            let n = reader.read_batch(&mut buffer, Duration::MAX).unwrap();
            if n == 0 {
                break;
            }
            assert!(n <= BATCH_BYTES);
            received.extend_from_slice(&buffer[..n]);
        }
        writer.join().unwrap();
        assert_eq!(received, data);
    }

    #[test]
    fn sends_sparse_output_without_waiting_for_a_full_batch_or_eof() {
        let (mut reader, mut writer) = pair();
        writer.write_all(b"> ").unwrap();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut buffer = [0; BATCH_BYTES];
            let result = reader
                .read_batch(&mut buffer, Duration::MAX)
                .map(|n| buffer[..n].to_vec());
            send.send(result).unwrap();
        });
        let result = receive.recv_timeout(Duration::from_millis(500));
        // Always release a regressed blocking reader before asserting.
        drop(writer);
        worker.join().unwrap();
        assert_eq!(result.unwrap().unwrap(), b"> ");
    }

    #[test]
    fn stops_at_the_time_budget_even_when_more_bytes_are_ready() {
        let (mut reader, mut writer) = pair();
        writer.write_all(&[b'x'; BATCH_BYTES]).unwrap();
        let mut buffer = [0; BATCH_BYTES];
        assert_eq!(
            reader.read_batch(&mut buffer, Duration::ZERO).unwrap(),
            1024
        );
    }

    #[test]
    fn falls_back_to_one_read_when_readiness_is_unavailable() {
        let (mut reader, mut writer) = pair();
        reader.readiness = None;
        writer.write_all(&[b'x'; BATCH_BYTES]).unwrap();
        assert_eq!(reader.read(&mut [0; BATCH_BYTES]).unwrap(), 1024);
        assert_eq!(reader.read(&mut []).unwrap(), 0);
    }
}
