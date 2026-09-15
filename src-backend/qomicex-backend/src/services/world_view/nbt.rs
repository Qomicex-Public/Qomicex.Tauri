use std::collections::HashMap;

#[derive(Debug, Clone)]
#[allow(dead_code)] // protocol-complete tag variants; not all are read by the renderer
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(Vec<Tag>),
    Compound(HashMap<String, Tag>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(m) => m.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Tag::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i32(&self) -> Option<i32> {
        match self {
            Tag::Byte(v) => Some(*v as i32),
            Tag::Short(v) => Some(*v as i32),
            Tag::Int(v) => Some(*v),
            Tag::Long(v) => Some(*v as i32),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Tag::Byte(v) => Some(*v as i64),
            Tag::Short(v) => Some(*v as i64),
            Tag::Int(v) => Some(*v as i64),
            Tag::Long(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Tag]> {
        match self {
            Tag::List(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_f64s(&self) -> Option<Vec<f64>> {
        match self {
            Tag::List(v) => {
                let mut out = Vec::with_capacity(v.len());
                for t in v {
                    out.push(match t {
                        Tag::Float(f) => *f as f64,
                        Tag::Double(d) => *d,
                        Tag::Int(i) => *i as f64,
                        _ => return None,
                    });
                }
                Some(out)
            }
            _ => None,
        }
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn need(&self, n: usize) -> Result<(), String> {
        if self.pos + n > self.buf.len() {
            Err(format!(
                "nbt truncated at {} (need {} more, len {})",
                self.pos,
                n,
                self.buf.len()
            ))
        } else {
            Ok(())
        }
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        self.need(1)?;
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn i16(&mut self) -> Result<i16, String> {
        self.need(2)?;
        let v = i16::from_be_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    pub fn i32(&mut self) -> Result<i32, String> {
        self.need(4)?;
        let v = i32::from_be_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    pub fn u64(&mut self) -> Result<u64, String> {
        self.need(8)?;
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(u64::from_be_bytes(b))
    }

    fn i64(&mut self) -> Result<i64, String> {
        self.need(8)?;
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(i64::from_be_bytes(b))
    }

    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.i32()? as u32))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_bits(self.i64()? as u64))
    }

    pub fn bytes(&mut self, n: usize) -> Result<Vec<u8>, String> {
        self.need(n)?;
        let v = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(v)
    }

    pub fn string(&mut self) -> Result<String, String> {
        let n = self.i16()? as usize;
        self.need(n)?;
        let s = String::from_utf8_lossy(&self.buf[self.pos..self.pos + n]).into_owned();
        self.pos += n;
        Ok(s)
    }

    /// Validate bounds and advance past `n` bytes.
    fn skip_bytes(&mut self, n: usize) -> Result<(), String> {
        self.need(n)?;
        self.pos += n;
        Ok(())
    }

    /// Advance past a payload of `tag_type` without materialising it.
    /// This is what makes loading chunks cheap: entities, tile entities and
    /// mod metadata make up the bulk of a chunk's NBT but are never rendered.
    pub fn skip(&mut self, tag_type: u8, depth: u32) -> Result<(), String> {
        if depth > 64 {
            return Err("nbt too deep".into());
        }
        match tag_type {
            1 => self.skip_bytes(1)?,
            2 => self.skip_bytes(2)?,
            3 | 5 => self.skip_bytes(4)?,
            4 | 6 => self.skip_bytes(8)?,
            7 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                self.skip_bytes(n as usize)?;
            }
            8 => {
                let n = self.i16()? as usize;
                self.skip_bytes(n)?;
            }
            9 => {
                let elem = self.u8()?;
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative list len".into());
                }
                for _ in 0..n {
                    self.skip(elem, depth + 1)?;
                }
            }
            10 => loop {
                let t = self.u8()?;
                if t == 0 {
                    break;
                }
                let _name = self.string()?;
                self.skip(t, depth + 1)?;
            },
            11 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                self.skip_bytes(n as usize * 4)?;
            }
            12 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                self.skip_bytes(n as usize * 8)?;
            }
            other => return Err(format!("unknown nbt tag type {}", other)),
        }
        Ok(())
    }

    fn payload(&mut self, tag_type: u8, depth: u32) -> Result<Tag, String> {
        if depth > 64 {
            return Err("nbt too deep".into());
        }
        Ok(match tag_type {
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(self.i16()?),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(self.i64()?),
            5 => Tag::Float(self.f32()?),
            6 => Tag::Double(self.f64()?),
            7 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                Tag::ByteArray(self.bytes(n as usize)?)
            }
            8 => Tag::String(self.string()?),
            9 => {
                let elem = self.u8()?;
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative list len".into());
                }
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(self.payload(elem, depth + 1)?);
                }
                Tag::List(v)
            }
            10 => {
                let mut m = HashMap::new();
                loop {
                    let t = self.u8()?;
                    if t == 0 {
                        break;
                    }
                    let name = self.string()?;
                    let val = self.payload(t, depth + 1)?;
                    m.insert(name, val);
                }
                Tag::Compound(m)
            }
            11 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(self.i32()?);
                }
                Tag::IntArray(v)
            }
            12 => {
                let n = self.i32()?;
                if n < 0 {
                    return Err("negative array len".into());
                }
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(self.i64()?);
                }
                Tag::LongArray(v)
            }
            other => return Err(format!("unknown nbt tag type {}", other)),
        })
    }
}

pub fn parse(data: &[u8]) -> Result<(String, Tag), String> {
    let mut r = Reader::new(data);
    let t = r.u8()?;
    let name = r.string()?;
    let root = r.payload(t, 0)?;
    Ok((name, root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roundtrip_small() {
        // root: TAG_Compound("x") { "k": TAG_Int(7) }
        let mut buf = vec![10u8, 0, 1, b'x'];
        buf.push(3); // TAG_Int
        buf.push(0);
        buf.push(1);
        buf.push(b'k'); // name "k"
        buf.extend_from_slice(&7i32.to_be_bytes());
        buf.push(0); // TAG_End
        let (name, tag) = parse(&buf).unwrap();
        assert_eq!(name, "x");
        assert_eq!(tag.get("k").unwrap().as_i32(), Some(7));
    }
}
