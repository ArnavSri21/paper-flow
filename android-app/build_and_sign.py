#!/usr/bin/env python3
import os
import sys
import zlib
import zipfile
import hashlib
import base64
import struct
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)

KEY_FILE = os.path.join(BASE_DIR, 'release.key')
CERT_FILE = os.path.join(BASE_DIR, 'release.crt')
CERT_DER = os.path.join(BASE_DIR, 'release.der')
PUBKEY_PEM = os.path.join(BASE_DIR, 'pubkey.pem')
PUBKEY_DER = os.path.join(BASE_DIR, 'pubkey.der')


def lp(data: bytes) -> bytes:
    return struct.pack('<I', len(data)) + data


def get_lp_slice(buf: bytes, offset: int = 0):
    if offset + 4 > len(buf):
        raise ValueError("Buffer underflow reading length prefix")
    length = struct.unpack_from('<I', buf, offset)[0]
    start = offset + 4
    end = start + length
    if end > len(buf):
        raise ValueError(f"Slice length {length} exceeds buffer size {len(buf) - start}")
    return buf[start:end], end


def format_manifest_line(line: str) -> bytes:
    b = line.encode('utf-8')
    if len(b) <= 70:
        return b + b'\r\n'
    out = bytearray()
    out.extend(b[:70] + b'\r\n')
    idx = 70
    while idx < len(b):
        chunk = b[idx:idx + 69]
        out.extend(b' ' + chunk + b'\r\n')
        idx += 69
    return bytes(out)


def ensure_keys():
    if not os.path.exists(KEY_FILE) or not os.path.exists(CERT_FILE):
        print("Generating persistent release key...")
        subprocess.run([
            'openssl', 'req', '-new', '-x509', '-newkey', 'rsa:2048',
            '-nodes', '-keyout', KEY_FILE, '-out', CERT_FILE,
            '-days', '10000',
            '-subj', '/C=IN/ST=IN/L=India/O=Paper Flow/OU=Paper Flow/CN=Arnav Srivastava'
        ], check=True, stderr=subprocess.PIPE)

    subprocess.run(['openssl', 'x509', '-in', CERT_FILE, '-outform', 'DER', '-out', CERT_DER], check=True)
    with open(PUBKEY_PEM, 'w') as pub_out:
        subprocess.run(['openssl', 'x509', '-in', CERT_FILE, '-noout', '-pubkey'], stdout=pub_out, check=True)
    subprocess.run(['openssl', 'rsa', '-pubin', '-in', PUBKEY_PEM, '-outform', 'DER', '-out', PUBKEY_DER], check=True, stderr=subprocess.PIPE)


def write_aligned_zip(out_path: str, entries: list):
    """
    entries: list of (arcname, raw_bytes, compress_type)
    Writes a strict 4-byte aligned ZIP without data descriptors.
    """
    out = bytearray()
    cd_entries = []

    for arcname, raw_bytes, compress_type in entries:
        fn_bytes = arcname.encode('utf-8')
        crc = zlib.crc32(raw_bytes) & 0xffffffff
        uncomp_size = len(raw_bytes)
        local_header_offset = len(out)

        if compress_type == zipfile.ZIP_STORED:
            comp_data = raw_bytes
            comp_size = uncomp_size
            # Align data payload offset to 4-byte boundary (4096 for resources.arsc for Android 11+ page alignment compatibility)
            align = 4
            pad = (align - ((local_header_offset + 30 + len(fn_bytes)) % align)) % align
            extra = b'\x00' * pad
        else:
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            comp_data = compressor.compress(raw_bytes) + compressor.flush()
            comp_size = len(comp_data)
            extra = b''

        local_header = struct.pack(
            '<4sHHHHHIIIHH',
            b'PK\x03\x04',
            20,              # version needed
            0,               # general purpose bit flag (no data descriptor)
            compress_type,
            0,               # mod time
            0x5221,          # mod date (2021-01-01)
            crc,
            comp_size,
            uncomp_size,
            len(fn_bytes),
            len(extra)
        )
        out.extend(local_header)
        out.extend(fn_bytes)
        out.extend(extra)
        out.extend(comp_data)

        cd_header = struct.pack(
            '<4sHHHHHHIIIHHHHHII',
            b'PK\x01\x02',
            20,              # version made by
            20,              # version needed
            0,               # flags
            compress_type,
            0,               # mod time
            0x5221,          # mod date
            crc,
            comp_size,
            uncomp_size,
            len(fn_bytes),
            0,               # extra len in CD
            0,               # comment len
            0,               # disk number
            0,               # internal attr
            0,               # external attr
            local_header_offset
        )
        cd_entries.append(cd_header + fn_bytes)

    cd_offset = len(out)
    cd_bytes = b''.join(cd_entries)
    out.extend(cd_bytes)

    eocd = struct.pack(
        '<4sHHHHIIH',
        b'PK\x05\x06',
        0,
        0,
        len(entries),
        len(entries),
        len(cd_bytes),
        cd_offset,
        0
    )
    out.extend(eocd)

    with open(out_path, 'wb') as f:
        f.write(out)


def rsa_sign_sha256(data: bytes) -> bytes:
    in_path = '/tmp/apk_sign_in.bin'
    out_path = '/tmp/apk_sign_out.bin'
    with open(in_path, 'wb') as f:
        f.write(data)
    subprocess.run([
        'openssl', 'dgst', '-sha256', '-sign', KEY_FILE,
        '-out', out_path, in_path
    ], check=True)
    with open(out_path, 'rb') as f:
        return f.read()


def compute_apk_top_digest(sec1: bytes, sec2: bytes, sec3_eocd_with_cd_off: bytes) -> bytes:
    def compute_section_digests(data: bytes):
        chunk_digests = []
        chunk_size = 1048576  # 1 MiB
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + chunk_size]
            h = hashlib.sha256(b'\xa5' + struct.pack('<I', len(chunk)) + chunk).digest()
            chunk_digests.append(h)
            offset += chunk_size
        return chunk_digests

    d1 = compute_section_digests(sec1)
    d2 = compute_section_digests(sec2)
    d3 = compute_section_digests(sec3_eocd_with_cd_off)
    all_chunks = d1 + d2 + d3
    return hashlib.sha256(
        b'\x5a' + struct.pack('<I', len(all_chunks)) + b''.join(all_chunks)
    ).digest()


def sign_v2_v3(in_zip_path: str, out_apk_path: str):
    with open(in_zip_path, 'rb') as f:
        zip_data = f.read()

    eocd_idx = zip_data.rfind(b'PK\x05\x06')
    if eocd_idx == -1:
        raise ValueError("Invalid ZIP file: EOCD not found")

    cd_size = struct.unpack_from('<I', zip_data, eocd_idx + 12)[0]
    cd_offset = struct.unpack_from('<I', zip_data, eocd_idx + 16)[0]

    sec1 = zip_data[:cd_offset]
    sec2 = zip_data[cd_offset:cd_offset + cd_size]
    sec3_before = zip_data[eocd_idx:]

    sec3_for_digest = bytearray(sec3_before)
    struct.pack_into('<I', sec3_for_digest, 16, cd_offset)

    top_digest = compute_apk_top_digest(sec1, sec2, bytes(sec3_for_digest))

    cert_der = open(CERT_DER, 'rb').read()
    pubkey_der = open(PUBKEY_DER, 'rb').read()

    # Common digest & certificate structures
    # 0x0103 = RSA_PKCS1_V1_5_WITH_SHA256
    digest_entry = struct.pack('<I', 0x0103) + lp(top_digest)
    digests = lp(digest_entry)
    certificates = lp(cert_der)

    # --- APK Signature Scheme v2 (ID = 0x7109871a) ---
    v2_signed_data = lp(digests) + lp(certificates) + lp(b'')
    v2_sig_bytes = rsa_sign_sha256(v2_signed_data)
    v2_sig_entry = struct.pack('<I', 0x0103) + lp(v2_sig_bytes)
    v2_signatures = lp(v2_sig_entry)
    v2_signer = lp(v2_signed_data) + lp(v2_signatures) + lp(pubkey_der)
    v2_block_value = lp(lp(v2_signer))
    v2_pair = struct.pack('<Q', 4 + len(v2_block_value)) + struct.pack('<I', 0x7109871a) + v2_block_value

    # --- APK Signature Scheme v3 (ID = 0xf05368c0) ---
    min_sdk = 21
    max_sdk = 0x7fffffff
    v3_signed_data = lp(digests) + lp(certificates) + struct.pack('<II', min_sdk, max_sdk) + lp(b'')
    v3_sig_bytes = rsa_sign_sha256(v3_signed_data)
    v3_sig_entry = struct.pack('<I', 0x0103) + lp(v3_sig_bytes)
    v3_signatures = lp(v3_sig_entry)
    v3_signer = lp(v3_signed_data) + struct.pack('<II', min_sdk, max_sdk) + lp(v3_signatures) + lp(pubkey_der)
    v3_block_value = lp(lp(v3_signer))
    v3_pair = struct.pack('<Q', 4 + len(v3_block_value)) + struct.pack('<I', 0xf05368c0) + v3_block_value

    pairs_body = v2_pair + v3_pair

    # Pad APK Signing Block to 4096-byte multiple (Verity padding ID = 0x42726577)
    total_without_pad = 8 + len(pairs_body) + 8 + 16
    rem = total_without_pad % 4096
    pad_needed = (4096 - rem) % 4096
    if pad_needed > 0:
        if pad_needed < 12:
            pad_needed += 4096
        pad_val = b'\x00' * (pad_needed - 12)
        pad_pair = struct.pack('<Q', 4 + len(pad_val)) + struct.pack('<I', 0x42726577) + pad_val
        pairs_body += pad_pair

    block_size_field = len(pairs_body) + 24
    apk_sig_block = (
        struct.pack('<Q', block_size_field) +
        pairs_body +
        struct.pack('<Q', block_size_field) +
        b'APK Sig Block 42'
    )

    new_cd_offset = cd_offset + len(apk_sig_block)
    sec3_final = bytearray(sec3_before)
    struct.pack_into('<I', sec3_final, 16, new_cd_offset)

    with open(out_apk_path, 'wb') as f:
        f.write(sec1)
        f.write(apk_sig_block)
        f.write(sec2)
        f.write(sec3_final)


def verify_apk(apk_path: str):
    """
    Strictly verifies:
    1. ZIP integrity & 4-byte alignment of all STORED entries (including resources.arsc)
    2. V1 JAR signature (line lengths <= 72, digests, CMS PKCS#7 signature)
    3. APK Signature Scheme v2 (0x7109871a) & v3 (0xf05368c0) structure, digests, and RSA signatures
    """
    with open(apk_path, 'rb') as f:
        data = f.read()

    # 1. Check ZIP & 4-byte alignment
    with zipfile.ZipFile(apk_path, 'r') as z:
        names = set(z.namelist())
        for req in ['AndroidManifest.xml', 'resources.arsc', 'classes.dex', 'assets/www/index.html',
                    'META-INF/MANIFEST.MF', 'META-INF/PAPERFLO.SF', 'META-INF/PAPERFLO.RSA']:
            assert req in names, f"Missing required entry: {req}"

        for info in z.infolist():
            assert (info.flag_bits & 0x08) == 0, f"Data descriptor flag set on {info.filename}"
            if info.filename == 'resources.arsc':
                assert info.compress_type == zipfile.ZIP_STORED, "resources.arsc must be uncompressed (ZIP_STORED)"
            if info.compress_type == zipfile.ZIP_STORED:
                off = info.header_offset
                fn_len, ex_len = struct.unpack_from('<HH', data, off + 26)
                data_off = off + 30 + fn_len + ex_len
                assert data_off % 4 == 0, f"Unaligned STORED entry {info.filename}: offset {data_off} (mod 4 = {data_off % 4})"

        # 2. Check V1 MANIFEST.MF and PAPERFLO.SF line lengths and CMS signature
        mf_bytes = z.read('META-INF/MANIFEST.MF')
        sf_bytes = z.read('META-INF/PAPERFLO.SF')
        rsa_bytes = z.read('META-INF/PAPERFLO.RSA')

        for label, content in [('MANIFEST.MF', mf_bytes), ('PAPERFLO.SF', sf_bytes)]:
            for raw_line in content.split(b'\r\n'):
                assert len(raw_line) <= 72, f"{label} line exceeds 72 bytes ({len(raw_line)}): {raw_line!r}"

        with open('/tmp/verify_sf.bin', 'wb') as f:
            f.write(sf_bytes)
        with open('/tmp/verify_rsa.bin', 'wb') as f:
            f.write(rsa_bytes)
        cms_res = subprocess.run([
            'openssl', 'cms', '-verify', '-binary', '-inform', 'DER',
            '-in', '/tmp/verify_rsa.bin', '-content', '/tmp/verify_sf.bin', '-noverify'
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        assert cms_res.stdout == sf_bytes, "V1 CMS signature verification content mismatch"

    # 3. Check APK Signing Block (v2 & v3)
    eocd_idx = data.rfind(b'PK\x05\x06')
    assert eocd_idx != -1, "EOCD not found"
    cd_size = struct.unpack_from('<I', data, eocd_idx + 12)[0]
    cd_offset = struct.unpack_from('<I', data, eocd_idx + 16)[0]

    assert data[cd_offset - 16:cd_offset] == b'APK Sig Block 42', "APK Sig Block 42 magic not right before Central Directory"
    block_size_bottom = struct.unpack_from('<Q', data, cd_offset - 24)[0]
    sig_block_start = cd_offset - 8 - block_size_bottom
    block_size_top = struct.unpack_from('<Q', data, sig_block_start)[0]
    assert block_size_top == block_size_bottom, "APK Sig Block size mismatch"

    sec1 = data[:sig_block_start]
    sec2 = data[cd_offset:cd_offset + cd_size]
    sec3_for_digest = bytearray(data[eocd_idx:])
    struct.pack_into('<I', sec3_for_digest, 16, sig_block_start)
    expected_top_digest = compute_apk_top_digest(sec1, sec2, bytes(sec3_for_digest))

    pairs_slice = data[sig_block_start + 8:cd_offset - 24]
    pos = 0
    found_pairs = {}
    while pos < len(pairs_slice):
        pair_len = struct.unpack_from('<Q', pairs_slice, pos)[0]
        pair_id = struct.unpack_from('<I', pairs_slice, pos + 8)[0]
        pair_val = pairs_slice[pos + 12:pos + 8 + pair_len]
        found_pairs[pair_id] = pair_val
        pos += 8 + pair_len

    assert 0x7109871a in found_pairs, "Missing APK Signature Scheme v2 (0x7109871a)"
    assert 0xf05368c0 in found_pairs, "Missing APK Signature Scheme v3 (0xf05368c0)"

    # Verify v2 structure & cryptographic signature
    v2_signers, end = get_lp_slice(found_pairs[0x7109871a], 0)
    assert end == len(found_pairs[0x7109871a])
    v2_signer, end = get_lp_slice(v2_signers, 0)
    assert end == len(v2_signers)

    v2_signed_data, off = get_lp_slice(v2_signer, 0)
    v2_signatures, off = get_lp_slice(v2_signer, off)
    v2_pubkey, off = get_lp_slice(v2_signer, off)
    assert off == len(v2_signer)

    v2_sig_entry, _ = get_lp_slice(v2_signatures, 0)
    v2_algo = struct.unpack_from('<I', v2_sig_entry, 0)[0]
    v2_sig_bytes, _ = get_lp_slice(v2_sig_entry, 4)
    assert v2_algo == 0x0103

    with open('/tmp/v2_sd.bin', 'wb') as f:
        f.write(v2_signed_data)
    with open('/tmp/v2_sig.bin', 'wb') as f:
        f.write(v2_sig_bytes)
    subprocess.run([
        'openssl', 'dgst', '-sha256', '-verify', PUBKEY_PEM,
        '-signature', '/tmp/v2_sig.bin', '/tmp/v2_sd.bin'
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    v2_digests, sd_off = get_lp_slice(v2_signed_data, 0)
    v2_certs, sd_off = get_lp_slice(v2_signed_data, sd_off)
    v2_attrs, sd_off = get_lp_slice(v2_signed_data, sd_off)
    assert sd_off == len(v2_signed_data)
    v2_digest_entry, _ = get_lp_slice(v2_digests, 0)
    v2_digest_val, _ = get_lp_slice(v2_digest_entry, 4)
    assert v2_digest_val == expected_top_digest, "V2 top digest mismatch"

    # Verify v3 structure & cryptographic signature
    v3_signers, end = get_lp_slice(found_pairs[0xf05368c0], 0)
    assert end == len(found_pairs[0xf05368c0])
    v3_signer, end = get_lp_slice(v3_signers, 0)
    assert end == len(v3_signers)

    v3_signed_data, off = get_lp_slice(v3_signer, 0)
    v3_min_sdk, v3_max_sdk = struct.unpack_from('<II', v3_signer, off)
    off += 8
    v3_signatures, off = get_lp_slice(v3_signer, off)
    v3_pubkey, off = get_lp_slice(v3_signer, off)
    assert off == len(v3_signer)

    v3_sig_entry, _ = get_lp_slice(v3_signatures, 0)
    v3_algo = struct.unpack_from('<I', v3_sig_entry, 0)[0]
    v3_sig_bytes, _ = get_lp_slice(v3_sig_entry, 4)
    assert v3_algo == 0x0103

    with open('/tmp/v3_sd.bin', 'wb') as f:
        f.write(v3_signed_data)
    with open('/tmp/v3_sig.bin', 'wb') as f:
        f.write(v3_sig_bytes)
    subprocess.run([
        'openssl', 'dgst', '-sha256', '-verify', PUBKEY_PEM,
        '-signature', '/tmp/v3_sig.bin', '/tmp/v3_sd.bin'
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    v3_digests, sd_off = get_lp_slice(v3_signed_data, 0)
    v3_certs, sd_off = get_lp_slice(v3_signed_data, sd_off)
    sd_min_sdk, sd_max_sdk = struct.unpack_from('<II', v3_signed_data, sd_off)
    sd_off += 8
    v3_attrs, sd_off = get_lp_slice(v3_signed_data, sd_off)
    assert sd_off == len(v3_signed_data)
    assert v3_min_sdk == sd_min_sdk == 21
    v3_digest_entry, _ = get_lp_slice(v3_digests, 0)
    v3_digest_val, _ = get_lp_slice(v3_digest_entry, 4)
    assert v3_digest_val == expected_top_digest, "V3 top digest mismatch"

    print("ALL VERIFICATION CHECKS PASSED: 4-byte aligned, V1 JAR + V2 + V3 signatures verified OK!")


def patch_classes_dex(dex_path: str):
    """
    Patches MainActivity$AndroidBridge.showNotification (M99 at code_off=5552, 132 code units)
    so that:
    1. When called with title="text/plainandroid.intent.extra.TEXT" and postId="android.intent.action.SEND",
       it constructs an Intent(Intent.ACTION_SEND) with type "text/plain" and EXTRA_TEXT = body,
       wraps it in Intent.createChooser(intent, "Paper Flow"), sets FLAG_ACTIVITY_NEW_TASK,
       and invokes MainActivity.startActivity(chooser) to pop up the native Android share sheet.
    2. Otherwise, it dispatches a high-priority system Notification via NotificationManager.notify
       with a PendingIntent deep-linking to the flow/message.
    """
    with open(dex_path, 'rb') as f:
        dex = bytearray(f.read())

    code_off = 5552
    regs, ins, outs, tries, dbg, insns_size = struct.unpack_from('<HHHHII', dex, code_off)
    if regs == 10 and ins == 4 and insns_size == 132:
        insns = [
            # Share check: if (v7 != null && v7.startsWith("text/"))
            0x0738, 0x0032,                 # 000: if-eqz v7, :not_share (+50 -> 050)
            0x011a, 0x0117,                 # 002: const-string v1, S279 ("text/")
            0x206e, 0x008e, 0x0017,         # 004: invoke-virtual {v7, v1}, M142 (String.startsWith)
            0x010a,                         # 007: move-result v1
            0x0138, 0x002a,                 # 008: if-eqz v1, :not_share (+42 -> 050)

            # v1 = v7.substring(10) -> "android.intent.extra.TEXT"
            0x0113, 0x000a,                 # 010: const/16 v1, 10
            0x206e, 0x008f, 0x0017,         # 012: invoke-virtual {v7, v1}, M143 (String.substring)
            0x010c,                         # 015: move-result-object v1

            # v2 = v7.replace(v1, "") -> "text/plain"
            0x021a, 0x0000,                 # 016: const-string v2, S0 ("")
            0x306e, 0x008d, 0x0217,         # 018: invoke-virtual {v7, v1, v2}, M141 (String.replace)
            0x020c,                         # 021: move-result-object v2

            # v3 = new Intent(v9) where v9 == "android.intent.action.SEND"
            0x0322, 0x0009,                 # 022: new-instance v3, T9 (Landroid/content/Intent;)
            0x2070, 0x0015, 0x0093,         # 024: invoke-direct {v3, v9}, M21 (Intent.<init>(String))
            0x206e, 0x001d, 0x0023,         # 027: invoke-virtual {v3, v2}, M29 (Intent.setType)
            0x306e, 0x001b, 0x0813,         # 030: invoke-virtual {v3, v1, v8}, M27 (Intent.putExtra)
            0x011a, 0x006b,                 # 033: const-string v1, S107 ("Paper Flow")
            0x2071, 0x0018, 0x0013,         # 035: invoke-static {v3, v1}, M24 (Intent.createChooser)
            0x030c,                         # 038: move-result-object v3
            0x0115, 0x1000,                 # 039: const/high16 v1, 0x10000000 (FLAG_ACTIVITY_NEW_TASK)
            0x206e, 0x001c, 0x0013,         # 041: invoke-virtual {v3, v1}, M28 (Intent.setFlags)
            0x6154, 0x0009,                 # 044: iget-object v1, v6, F9 (this.this$0)
            0x206e, 0x0080, 0x0031,         # 046: invoke-virtual {v1, v3}, M128 (MainActivity.startActivity)
            0x000e,                         # 049: return-void

            # :not_share (050) — OS Notification Dispatch
            0x6054, 0x0009,                 # 050: iget-object v0, v6, F9 (this.this$0)
            0x011a, 0x00d4,                 # 052: const-string v1, S212 ("notification")
            0x206e, 0x0073, 0x0010,         # 054: invoke-virtual {v0, v1}, M115 (getSystemService)
            0x000c,                         # 057: move-result-object v0
            0x001f, 0x0006,                 # 058: check-cast v0, T6 (NotificationManager)
            0x0038, 0x0047,                 # 060: if-eqz v0, :done_ret (+71 -> 131)

            0x0122, 0x0009,                 # 062: new-instance v1, T9 (Intent)
            0x6254, 0x0009,                 # 064: iget-object v2, v6, F9 (this.this$0)
            0x031c, 0x0028,                 # 066: const-class v3, T40 (MainActivity.class)
            0x3070, 0x0014, 0x0321,         # 068: invoke-direct {v1, v2, v3}, M20 (Intent.<init>(Context, Class))
            0x0215, 0x2400,                 # 071: const/high16 v2, 0x24000000
            0x206e, 0x001c, 0x0021,         # 073: invoke-virtual {v1, v2}, M28 (Intent.setFlags)
            0x021a, 0x00e3,                 # 076: const-string v2, S227 ("postId")
            0x306e, 0x001b, 0x0921,         # 078: invoke-virtual {v1, v2, v9}, M27 (Intent.putExtra)

            0x0415, 0x0c00,                 # 081: const/high16 v4, 0x0c000000
            0x6254, 0x0009,                 # 083: iget-object v2, v6, F9 (this.this$0)
            0x1071, 0x006c, 0x0002,         # 085: invoke-static {v2}, M108 (access$504)
            0x020a,                         # 088: move-result v2
            0x6354, 0x0009,                 # 089: iget-object v3, v6, F9 (this.this$0)
            0x4071, 0x0013, 0x4123,         # 091: invoke-static {v3, v2, v1, v4}, M19 (PendingIntent.getActivity)
            0x040c,                         # 094: move-result-object v4

            0x0122, 0x0003,                 # 095: new-instance v1, T3 (Notification$Builder)
            0x6354, 0x0009,                 # 097: iget-object v3, v6, F9 (this.this$0)
            0x051a, 0x00df,                 # 099: const-string v5, S223 ("paperflow_alerts")
            0x3070, 0x0006, 0x0531,         # 101: invoke-direct {v1, v3, v5}, M6 (Builder.<init>(Context, String))

            0x0315, 0x7f02,                 # 104: const/high16 v3, 0x7f020000
            0x206e, 0x000d, 0x0031,         # 106: invoke-virtual {v1, v3}, M13 (setSmallIcon)
            0x206e, 0x000b, 0x0071,         # 109: invoke-virtual {v1, v7}, M11 (setContentTitle)
            0x206e, 0x000a, 0x0081,         # 112: invoke-virtual {v1, v8}, M10 (setContentText)
            0x1312,                         # 115: const/4 v3, 1
            0x206e, 0x0008, 0x0031,         # 116: invoke-virtual {v1, v3}, M8 (setAutoCancel)
            0x206e, 0x0009, 0x0041,         # 119: invoke-virtual {v1, v4}, M9 (setContentIntent)
            0x106e, 0x0007, 0x0001,         # 122: invoke-virtual {v1}, M7 (build)
            0x010c,                         # 125: move-result-object v1
            0x306e, 0x0012, 0x0120,         # 126: invoke-virtual {v0, v2, v1}, M18 (nm.notify)

            0x0228,                         # 129: goto +2 (-> 131 :done_ret)
            0x070d,                         # 130: move-exception v7 (catch handler @ 0x82)
            0x000e                          # 131: return-void (:done_ret)
        ]
        assert len(insns) == 132, f"Expected 132 code units, got {len(insns)}"
        # Clear debug_info_off for M99 so stale line table is not used
        struct.pack_into('<I', dex, code_off + 8, 0)
        for idx, word in enumerate(insns):
            struct.pack_into('<H', dex, code_off + 16 + idx * 2, word)

        # Recompute DEX SHA-1 signature (bytes 12..32) over bytes 32..end
        sha1_digest = hashlib.sha1(dex[32:]).digest()
        dex[12:32] = sha1_digest

        # Recompute DEX Adler32 checksum (bytes 8..12) over bytes 12..end
        adler = zlib.adler32(dex[12:]) & 0xffffffff
        struct.pack_into('<I', dex, 8, adler)

        with open(dex_path, 'wb') as f:
            f.write(dex)
        print("Patched classes.dex M99 with native Android Share Chooser + Notification support!")


def build_apk():
    ensure_keys()
    src_apk = os.path.join(ROOT_DIR, 'Paper-Flow.apk')
    work_dir = '/tmp/apk_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir, exist_ok=True)

    with zipfile.ZipFile(src_apk, 'r') as z:
        for member in z.infolist():
            if not member.filename.startswith('META-INF/'):
                z.extract(member, work_dir)

    dex_file = os.path.join(work_dir, 'classes.dex')
    if os.path.exists(dex_file):
        patch_classes_dex(dex_file)

    # Sync latest web files from root into assets/www/ (keep compact icon size for fast download)
    for fname in ['index.html', 'manifest.json', 'sw.js', 'icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png']:
        src_f = os.path.join(ROOT_DIR, fname)
        if os.path.exists(src_f):
            dst_f = os.path.join(work_dir, 'assets', 'www', fname)
            os.makedirs(os.path.dirname(dst_f), exist_ok=True)
            shutil.copyfile(src_f, dst_f)
    compact_icon = os.path.join(ROOT_DIR, 'pwa-192x192.png')
    if os.path.exists(compact_icon):
        for icon_target in ['pwa-512x512.png', 'pwa-maskable-512x512.png']:
            shutil.copyfile(compact_icon, os.path.join(work_dir, 'assets', 'www', icon_target))

    # Collect all non-META-INF files in canonical order:
    # AndroidManifest.xml first, then res/*, then resources.arsc, then assets/*, then classes.dex
    file_list = []
    for root, _, files in os.walk(work_dir):
        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, work_dir).replace('\\', '/')
            if not rel_path.startswith('META-INF/'):
                file_list.append((rel_path, full_path))

    def sort_key(item):
        name = item[0]
        if name == 'AndroidManifest.xml':
            return (0, name)
        if name.startswith('res/'):
            return (1, name)
        if name == 'resources.arsc':
            return (2, name)
        if name.startswith('assets/'):
            return (3, name)
        if name == 'classes.dex':
            return (4, name)
        return (5, name)

    file_list.sort(key=sort_key)

    # Build V1 META-INF/MANIFEST.MF and META-INF/PAPERFLO.SF with strict 70-byte line wrapping
    manifest_chunks = [b'Manifest-Version: 1.0\r\nCreated-By: 1.0 (Android)\r\n\r\n']
    entry_sections = []

    for rel_path, full_path in file_list:
        with open(full_path, 'rb') as fp:
            raw = fp.read()
        digest = base64.b64encode(hashlib.sha256(raw).digest()).decode('ascii')
        sec = (
            format_manifest_line(f"Name: {rel_path}") +
            format_manifest_line(f"SHA-256-Digest: {digest}") +
            b'\r\n'
        )
        manifest_chunks.append(sec)
        entry_sections.append((rel_path, sec))

    manifest_bytes = b''.join(manifest_chunks)
    manifest_digest = base64.b64encode(hashlib.sha256(manifest_bytes).digest()).decode('ascii')

    sf_chunks = [
        b'Signature-Version: 1.0\r\n',
        b'Created-By: 1.0 (Android)\r\n',
        format_manifest_line(f"SHA-256-Digest-Manifest: {manifest_digest}"),
        b'X-Android-APK-Signed: 2, 3\r\n\r\n'
    ]

    for rel_path, sec in entry_sections:
        sec_digest = base64.b64encode(hashlib.sha256(sec).digest()).decode('ascii')
        sf_sec = (
            format_manifest_line(f"Name: {rel_path}") +
            format_manifest_line(f"SHA-256-Digest: {sec_digest}") +
            b'\r\n'
        )
        sf_chunks.append(sf_sec)

    sf_bytes = b''.join(sf_chunks)

    meta_dir = os.path.join(work_dir, 'META-INF')
    os.makedirs(meta_dir, exist_ok=True)
    mf_path = os.path.join(meta_dir, 'MANIFEST.MF')
    sf_path = os.path.join(meta_dir, 'PAPERFLO.SF')
    rsa_path = os.path.join(meta_dir, 'PAPERFLO.RSA')

    with open(mf_path, 'wb') as f:
        f.write(manifest_bytes)
    with open(sf_path, 'wb') as f:
        f.write(sf_bytes)

    subprocess.run([
        'openssl', 'cms', '-sign', '-nodetach', '-binary',
        '-in', sf_path,
        '-signer', CERT_FILE, '-inkey', KEY_FILE,
        '-outform', 'DER', '-out', rsa_path
    ], check=True, stderr=subprocess.PIPE)

    rsa_bytes = open(rsa_path, 'rb').read()

    # Prepare ordered entries for aligned ZIP
    zip_entries = []
    for rel_path, full_path in file_list:
        raw = open(full_path, 'rb').read()
        is_stored = (rel_path == 'resources.arsc' or rel_path.endswith('.png'))
        comp_type = zipfile.ZIP_STORED if is_stored else zipfile.ZIP_DEFLATED
        zip_entries.append((rel_path, raw, comp_type))

    zip_entries.append(('META-INF/PAPERFLO.SF', sf_bytes, zipfile.ZIP_DEFLATED))
    zip_entries.append(('META-INF/PAPERFLO.RSA', rsa_bytes, zipfile.ZIP_DEFLATED))
    zip_entries.append(('META-INF/MANIFEST.MF', manifest_bytes, zipfile.ZIP_DEFLATED))

    aligned_zip_path = '/tmp/aligned_unsigned.apk'
    write_aligned_zip(aligned_zip_path, zip_entries)

    signed_apk_path = '/tmp/signed_final.apk'
    sign_v2_v3(aligned_zip_path, signed_apk_path)

    # Run strict verification before copying
    verify_apk(signed_apk_path)

    shutil.copyfile(signed_apk_path, os.path.join(ROOT_DIR, 'Paper-Flow.apk'))
    shutil.copyfile(signed_apk_path, os.path.join(ROOT_DIR, 'public', 'Paper-Flow.apk'))
    size = os.path.getsize(os.path.join(ROOT_DIR, 'Paper-Flow.apk'))
    print(f"Paper-Flow.apk successfully built, aligned, signed (v1+v2+v3), and verified: {size} bytes")


if __name__ == '__main__':
    build_apk()
