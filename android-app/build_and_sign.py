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


def read_uleb128(buf: bytes, pos: int):
    val = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7f) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return val, pos


def write_uleb128(val: int) -> bytes:
    out = bytearray()
    while True:
        byte = val & 0x7f
        val >>= 7
        if val != 0:
            byte |= 0x80
        out.append(byte)
        if val == 0:
            break
    return bytes(out)


def write_sleb128(val: int) -> bytes:
    out = bytearray()
    while True:
        byte = val & 0x7f
        val >>= 7
        if (val == 0 and (byte & 0x40) == 0) or (val == -1 and (byte & 0x40) != 0):
            out.append(byte)
            break
        out.append(byte | 0x80)
    return bytes(out)


def insn_width(op: int) -> int:
    if op in (0x00, 0x01, 0x04, 0x07, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x1d, 0x1e, 0x21, 0x27, 0x28) or (0x44 <= op <= 0x51) or (0x7b <= op <= 0xdf):
        return 1
    if op in (0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29, 0x2d, 0x2e, 0x2f, 0x30, 0x31) or (0x32 <= op <= 0x3d) or (0x52 <= op <= 0x6d) or (0xe0 <= op <= 0xff):
        return 2
    if op in (0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c) or (0x6e <= op <= 0x78):
        return 3
    if op == 0x18:
        return 5
    raise ValueError(f"Unknown Dalvik opcode {hex(op)}")


def patch_classes_dex(dex_path: str):
    """
    Rebuilds classes.dex from android-app/base_classes.dex to add:
    - android.util.Base64.decode(String, int) -> byte[]
    - android.graphics.BitmapFactory.decodeByteArray(byte[], int, int) -> Bitmap
    - MainActivity.getContentResolver() -> ContentResolver
    - android.provider.MediaStore$Images$Media.insertImage(ContentResolver, Bitmap, String, String) -> String
    - android.content.Intent.putExtra(String, Parcelable) -> Intent
    And upgrades MainActivity$AndroidBridge.showNotification(title, body, postId) so that:
    1. title == "IMAGE_SHARE": decodes base64 PNG/JPEG snapshot in body, inserts it into MediaStore,
       attaches EXTRA_STREAM (content:// image Uri) + EXTRA_TEXT (postId caption & link) with
       FLAG_GRANT_READ_URI_PERMISSION, and opens Android's native Share Chooser with the image snapshot!
    2. title.startsWith("text/"): opens Android's native text Share Chooser.
    3. Otherwise: checks/requests Android 13+ POST_NOTIFICATIONS runtime permission via
       MainActivity.requestPermissions, and if body is non-empty, dispatches a high-priority OS Notification.
    """
    base_dex_path = os.path.join(BASE_DIR, 'base_classes.dex')
    src_path = base_dex_path if os.path.exists(base_dex_path) else dex_path
    with open(src_path, 'rb') as f:
        dex = f.read()

    string_ids_size, string_ids_off = struct.unpack_from('<II', dex, 56)
    type_ids_size, type_ids_off = struct.unpack_from('<II', dex, 64)
    proto_ids_size, proto_ids_off = struct.unpack_from('<II', dex, 72)
    field_ids_size, field_ids_off = struct.unpack_from('<II', dex, 80)
    method_ids_size, method_ids_off = struct.unpack_from('<II', dex, 88)
    class_defs_size, class_defs_off = struct.unpack_from('<II', dex, 96)

    old_strings = []
    for i in range(string_ids_size):
        off = struct.unpack_from('<I', dex, string_ids_off + i * 4)[0]
        _, pos = read_uleb128(dex, off)
        end = dex.find(b'\x00', pos)
        old_strings.append(dex[pos:end].decode('utf-8'))

    old_types = [old_strings[struct.unpack_from('<I', dex, type_ids_off + i * 4)[0]] for i in range(type_ids_size)]

    old_protos = []
    for i in range(proto_ids_size):
        sh_i, ret_i, param_off = struct.unpack_from('<III', dex, proto_ids_off + i * 12)
        params = []
        if param_off:
            sz = struct.unpack_from('<I', dex, param_off)[0]
            for k in range(sz):
                t_idx = struct.unpack_from('<H', dex, param_off + 4 + k * 2)[0]
                params.append(old_types[t_idx])
        old_protos.append((old_strings[sh_i], old_types[ret_i], tuple(params)))

    old_fields = []
    for i in range(field_ids_size):
        cl_i, ty_i, nm_i = struct.unpack_from('<HHI', dex, field_ids_off + i * 8)
        old_fields.append((old_types[cl_i], old_types[ty_i], old_strings[nm_i]))

    old_methods = []
    for i in range(method_ids_size):
        cl_i, pr_i, nm_i = struct.unpack_from('<HHI', dex, method_ids_off + i * 8)
        old_methods.append((old_types[cl_i], old_protos[pr_i], old_strings[nm_i]))

    # Parse classes and symbolic code items
    parsed_classes = []
    for c in range(class_defs_size):
        class_idx, access, super_idx, interfaces_off, src_idx, annot_off, class_data_off, static_off = struct.unpack_from('<IIIIIIII', dex, class_defs_off + c * 32)
        ifaces = []
        if interfaces_off:
            sz = struct.unpack_from('<I', dex, interfaces_off)[0]
            for k in range(sz):
                t_idx = struct.unpack_from('<H', dex, interfaces_off + 4 + k * 2)[0]
                ifaces.append(old_types[t_idx])

        s_fields, i_fields, d_methods, v_methods = [], [], [], []
        if class_data_off:
            pos = class_data_off
            sf_sz, pos = read_uleb128(dex, pos)
            if_sz, pos = read_uleb128(dex, pos)
            dm_sz, pos = read_uleb128(dex, pos)
            vm_sz, pos = read_uleb128(dex, pos)

            f_idx = 0
            for _ in range(sf_sz):
                diff, pos = read_uleb128(dex, pos)
                f_idx += diff
                acc, pos = read_uleb128(dex, pos)
                s_fields.append((old_fields[f_idx], acc))

            f_idx = 0
            for _ in range(if_sz):
                diff, pos = read_uleb128(dex, pos)
                f_idx += diff
                acc, pos = read_uleb128(dex, pos)
                i_fields.append((old_fields[f_idx], acc))

            for target_list, count in [(d_methods, dm_sz), (v_methods, vm_sz)]:
                m_idx = 0
                for _ in range(count):
                    diff, pos = read_uleb128(dex, pos)
                    m_idx += diff
                    acc, pos = read_uleb128(dex, pos)
                    code_off, pos = read_uleb128(dex, pos)
                    code_obj = None
                    if code_off:
                        regs, ins, outs, tries, _, insns_size = struct.unpack_from('<HHHHII', dex, code_off)
                        insns = [struct.unpack_from('<H', dex, code_off + 16 + k * 2)[0] for k in range(insns_size)]
                        sym_refs = {}
                        pc = 0
                        while pc < insns_size:
                            op = insns[pc] & 0xff
                            w = insn_width(op)
                            if op == 0x1a:
                                sym_refs[pc] = ('str', old_strings[insns[pc + 1]])
                            elif op in (0x1c, 0x1f, 0x20, 0x22, 0x23, 0x24):
                                sym_refs[pc] = ('type', old_types[insns[pc + 1]])
                            elif 0x52 <= op <= 0x6d:
                                sym_refs[pc] = ('field', old_fields[insns[pc + 1]])
                            elif 0x6e <= op <= 0x72:
                                sym_refs[pc] = ('method', old_methods[insns[pc + 1]])
                            pc += w

                        try_info = None
                        if tries == 1:
                            t_off = code_off + 16 + insns_size * 2 + (2 if insns_size % 2 == 1 else 0)
                            start_addr, insn_cnt, _ = struct.unpack_from('<IHH', dex, t_off)
                            h_list_off = t_off + 8
                            _, h_pos = read_uleb128(dex, h_list_off)      # list size (1)
                            _, h_pos = read_uleb128(dex, h_pos)           # sleb128 size (1)
                            c_type_idx, h_pos = read_uleb128(dex, h_pos)
                            c_addr, _ = read_uleb128(dex, h_pos)
                            try_info = (start_addr, insn_cnt, old_types[c_type_idx], c_addr)

                        code_obj = {
                            'regs': regs,
                            'ins': ins,
                            'outs': outs,
                            'insns': insns,
                            'sym_refs': sym_refs,
                            'try_info': try_info
                        }
                    target_list.append((old_methods[m_idx], acc, code_obj))

        parsed_classes.append({
            'class_type': old_types[class_idx],
            'access': access,
            'super_type': old_types[super_idx],
            'ifaces': tuple(ifaces),
            'src_file': old_strings[src_idx],
            's_fields': s_fields,
            'i_fields': i_fields,
            'd_methods': d_methods,
            'v_methods': v_methods
        })

    # Add new strings, types, protos, and methods for native Snapshot Image Share + Notification Permission
    extra_strings = [
        "IMAGE_SHARE",
        "android.intent.action.SEND",
        "android.intent.extra.STREAM",
        "android.intent.extra.TEXT",
        "text/plain",
        "[B",
        "Landroid/content/ContentResolver;",
        "Landroid/graphics/Bitmap;",
        "Landroid/graphics/BitmapFactory;",
        "Landroid/os/Parcelable;",
        "Landroid/provider/MediaStore$Images$Media;",
        "Landroid/util/Base64;",
        "decode",
        "decodeByteArray",
        "getContentResolver",
        "insertImage",
        "LLI",
        "LLII",
        "LLLLL",
    ]
    extra_types = [
        "[B",
        "Landroid/content/ContentResolver;",
        "Landroid/graphics/Bitmap;",
        "Landroid/graphics/BitmapFactory;",
        "Landroid/os/Parcelable;",
        "Landroid/provider/MediaStore$Images$Media;",
        "Landroid/util/Base64;",
    ]
    extra_protos = [
        ("LLI", "[B", ("Ljava/lang/String;", "I")),
        ("LLII", "Landroid/graphics/Bitmap;", ("[B", "I", "I")),
        ("L", "Landroid/content/ContentResolver;", ()),
        ("LLLLL", "Ljava/lang/String;", ("Landroid/content/ContentResolver;", "Landroid/graphics/Bitmap;", "Ljava/lang/String;", "Ljava/lang/String;")),
        ("LLL", "Landroid/content/Intent;", ("Ljava/lang/String;", "Landroid/os/Parcelable;")),
    ]
    extra_methods = [
        ("Landroid/util/Base64;", ("LLI", "[B", ("Ljava/lang/String;", "I")), "decode"),
        ("Landroid/graphics/BitmapFactory;", ("LLII", "Landroid/graphics/Bitmap;", ("[B", "I", "I")), "decodeByteArray"),
        ("Lcom/arnavsri/paperflow/MainActivity;", ("L", "Landroid/content/ContentResolver;", ()), "getContentResolver"),
        ("Landroid/provider/MediaStore$Images$Media;", ("LLLLL", "Ljava/lang/String;", ("Landroid/content/ContentResolver;", "Landroid/graphics/Bitmap;", "Ljava/lang/String;", "Ljava/lang/String;")), "insertImage"),
        ("Landroid/content/Intent;", ("LLL", "Landroid/content/Intent;", ("Ljava/lang/String;", "Landroid/os/Parcelable;")), "putExtra"),
    ]

    new_strings = sorted(set(old_strings) | set(extra_strings))
    str_map = {s: i for i, s in enumerate(new_strings)}

    new_types = sorted(set(old_types) | set(extra_types), key=lambda t: str_map[t])
    type_map = {t: i for i, t in enumerate(new_types)}

    new_protos = sorted(
        set(old_protos) | set(extra_protos),
        key=lambda p: (type_map[p[1]], tuple(type_map[x] for x in p[2]))
    )
    proto_map = {p: i for i, p in enumerate(new_protos)}

    new_fields = sorted(
        set(old_fields),
        key=lambda f: (type_map[f[0]], str_map[f[2]], type_map[f[1]])
    )
    field_map = {f: i for i, f in enumerate(new_fields)}

    new_methods = sorted(
        set(old_methods) | set(extra_methods),
        key=lambda m: (type_map[m[0]], str_map[m[2]], proto_map[m[1]])
    )
    method_map = {m: i for i, m in enumerate(new_methods)}

    def S(s): return str_map[s]
    def T(t): return type_map[t]
    def F(cl, ty, nm): return field_map[(cl, ty, nm)]
    def M(cl, nm, sh, ret, params): return method_map[(cl, (sh, ret, tuple(params)), nm)]

    # Build upgraded bytecode for MainActivity$AndroidBridge.showNotification(String v7, String v8, String v9)
    # Using label resolution for branches
    asm = []
    labels = {}
    branches = []

    def emit(*words):
        asm.extend(words)

    def label(name):
        labels[name] = len(asm)

    def branch(op_word, target_label):
        pc = len(asm)
        asm.extend([op_word, 0])
        branches.append((pc, target_label, 2))

    def goto8(target_label):
        pc = len(asm)
        asm.append(0x0028)
        branches.append((pc, target_label, 1))

    F_THIS0 = F("Lcom/arnavsri/paperflow/MainActivity$AndroidBridge;", "Lcom/arnavsri/paperflow/MainActivity;", "this$0")
    F_SDK_INT = F("Landroid/os/Build$VERSION;", "I", "SDK_INT")

    M_STR_EQUALS = M("Ljava/lang/String;", "equals", "ZL", "Z", ("Ljava/lang/Object;",))
    M_STR_STARTS = M("Ljava/lang/String;", "startsWith", "ZL", "Z", ("Ljava/lang/String;",))
    M_STR_EMPTY = M("Ljava/lang/String;", "isEmpty", "Z", "Z", ())
    M_INTENT_INIT_ACT = M("Landroid/content/Intent;", "<init>", "VL", "V", ("Ljava/lang/String;",))
    M_INTENT_INIT_CLS = M("Landroid/content/Intent;", "<init>", "VLL", "V", ("Landroid/content/Context;", "Ljava/lang/Class;"))
    M_INTENT_SET_TYPE = M("Landroid/content/Intent;", "setType", "LL", "Landroid/content/Intent;", ("Ljava/lang/String;",))
    M_INTENT_PUT_STR = M("Landroid/content/Intent;", "putExtra", "LLL", "Landroid/content/Intent;", ("Ljava/lang/String;", "Ljava/lang/String;"))
    M_INTENT_PUT_PARC = M("Landroid/content/Intent;", "putExtra", "LLL", "Landroid/content/Intent;", ("Ljava/lang/String;", "Landroid/os/Parcelable;"))
    M_INTENT_SET_FLAGS = M("Landroid/content/Intent;", "setFlags", "LI", "Landroid/content/Intent;", ("I",))
    M_INTENT_CHOOSER = M("Landroid/content/Intent;", "createChooser", "LLL", "Landroid/content/Intent;", ("Landroid/content/Intent;", "Ljava/lang/CharSequence;"))
    M_B64_DECODE = M("Landroid/util/Base64;", "decode", "LLI", "[B", ("Ljava/lang/String;", "I"))
    M_BMP_DECODE = M("Landroid/graphics/BitmapFactory;", "decodeByteArray", "LLII", "Landroid/graphics/Bitmap;", ("[B", "I", "I"))
    M_GET_CR = M("Lcom/arnavsri/paperflow/MainActivity;", "getContentResolver", "L", "Landroid/content/ContentResolver;", ())
    M_INSERT_IMG = M("Landroid/provider/MediaStore$Images$Media;", "insertImage", "LLLLL", "Ljava/lang/String;", ("Landroid/content/ContentResolver;", "Landroid/graphics/Bitmap;", "Ljava/lang/String;", "Ljava/lang/String;"))
    M_URI_PARSE = M("Landroid/net/Uri;", "parse", "LL", "Landroid/net/Uri;", ("Ljava/lang/String;",))
    M_START_ACT = M("Lcom/arnavsri/paperflow/MainActivity;", "startActivity", "VL", "V", ("Landroid/content/Intent;",))
    M_CHECK_PERM = M("Lcom/arnavsri/paperflow/MainActivity;", "checkSelfPermission", "IL", "I", ("Ljava/lang/String;",))
    M_REQ_PERM = M("Lcom/arnavsri/paperflow/MainActivity;", "requestPermissions", "VLI", "V", ("[Ljava/lang/String;", "I"))
    M_GET_SYS_SVC = M("Lcom/arnavsri/paperflow/MainActivity;", "getSystemService", "LL", "Ljava/lang/Object;", ("Ljava/lang/String;",))
    M_ACCESS_504 = M("Lcom/arnavsri/paperflow/MainActivity;", "access$504", "IL", "I", ("Lcom/arnavsri/paperflow/MainActivity;",))
    M_PI_GET_ACT = M("Landroid/app/PendingIntent;", "getActivity", "LLILI", "Landroid/app/PendingIntent;", ("Landroid/content/Context;", "I", "Landroid/content/Intent;", "I"))
    M_NB_INIT = M("Landroid/app/Notification$Builder;", "<init>", "VLL", "V", ("Landroid/content/Context;", "Ljava/lang/String;"))
    M_NB_ICON = M("Landroid/app/Notification$Builder;", "setSmallIcon", "LI", "Landroid/app/Notification$Builder;", ("I",))
    M_NB_TITLE = M("Landroid/app/Notification$Builder;", "setContentTitle", "LL", "Landroid/app/Notification$Builder;", ("Ljava/lang/CharSequence;",))
    M_NB_TEXT = M("Landroid/app/Notification$Builder;", "setContentText", "LL", "Landroid/app/Notification$Builder;", ("Ljava/lang/CharSequence;",))
    M_NB_AUTOCANCEL = M("Landroid/app/Notification$Builder;", "setAutoCancel", "LZ", "Landroid/app/Notification$Builder;", ("Z",))
    M_NB_INTENT = M("Landroid/app/Notification$Builder;", "setContentIntent", "LL", "Landroid/app/Notification$Builder;", ("Landroid/app/PendingIntent;",))
    M_NB_BUILD = M("Landroid/app/Notification$Builder;", "build", "L", "Landroid/app/Notification;", ())
    M_NM_NOTIFY = M("Landroid/app/NotificationManager;", "notify", "VIL", "V", ("I", "Landroid/app/Notification;"))

    # --- Start of M99 (showNotification) ---
    branch(0x0738, 'done_ret')                                   # if-eqz v7, :done_ret

    # 1. Check if v7.equals("IMAGE_SHARE")
    emit(0x001a, S("IMAGE_SHARE"))                               # const-string v0, "IMAGE_SHARE"
    emit(0x206e, M_STR_EQUALS, 0x0007)                           # invoke-virtual {v7, v0}, String.equals
    emit(0x000a)                                                 # move-result v0
    branch(0x0038, 'check_text_share')                           # if-eqz v0, :check_text_share

    # v3 = new Intent("android.intent.action.SEND")
    emit(0x001a, S("android.intent.action.SEND"))                # const-string v0, "android.intent.action.SEND"
    emit(0x0322, T("Landroid/content/Intent;"))                  # new-instance v3, Intent
    emit(0x2070, M_INTENT_INIT_ACT, 0x0003)                      # invoke-direct {v3, v0}, Intent.<init>(String)

    # Decode base64 PNG/JPEG in v8 -> byte[] in v0
    emit(0x0112)                                                 # const/4 v1, 0
    emit(0x2071, M_B64_DECODE, 0x0018)                           # invoke-static {v8, v1}, Base64.decode
    emit(0x000c)                                                 # move-result-object v0
    branch(0x0038, 'fallback_text_only')                         # if-eqz v0, :fallback_text_only
    emit(0x0221)                                                 # array-length v2, v0
    emit(0x3071, M_BMP_DECODE, 0x0210)                           # invoke-static {v0, v1, v2}, BitmapFactory.decodeByteArray
    emit(0x010c)                                                 # move-result-object v1
    branch(0x0138, 'fallback_text_only')                         # if-eqz v1, :fallback_text_only

    # Insert Bitmap into MediaStore.Images.Media -> uriStr in v0
    emit(0x6054, F_THIS0)                                        # iget-object v0, v6, this$0
    emit(0x106e, M_GET_CR, 0x0000)                               # invoke-virtual {v0}, MainActivity.getContentResolver
    emit(0x000c)                                                 # move-result-object v0
    emit(0x021a, S("Paper Flow"))                                # const-string v2, "Paper Flow"
    emit(0x4071, M_INSERT_IMG, 0x2210)                           # invoke-static {v0, v1, v2, v2}, MediaStore$Images$Media.insertImage
    emit(0x000c)                                                 # move-result-object v0
    branch(0x0038, 'fallback_text_only')                         # if-eqz v0, :fallback_text_only

    # Parse Uri and attach EXTRA_STREAM + setType("image/*") + setFlags(1)
    emit(0x1071, M_URI_PARSE, 0x0000)                            # invoke-static {v0}, Uri.parse
    emit(0x000c)                                                 # move-result-object v0
    emit(0x011a, S("image/*"))                                   # const-string v1, "image/*"
    emit(0x206e, M_INTENT_SET_TYPE, 0x0013)                      # invoke-virtual {v3, v1}, Intent.setType
    emit(0x011a, S("android.intent.extra.STREAM"))               # const-string v1, "android.intent.extra.STREAM"
    emit(0x306e, M_INTENT_PUT_PARC, 0x0013)                      # invoke-virtual {v3, v1, v0}, Intent.putExtra(String, Parcelable)
    emit(0x1112)                                                 # const/4 v1, 1 (FLAG_GRANT_READ_URI_PERMISSION)
    emit(0x206e, M_INTENT_SET_FLAGS, 0x0013)                     # invoke-virtual {v3, v1}, Intent.setFlags
    goto8('attach_extra_text')

    label('fallback_text_only')
    emit(0x011a, S("text/plain"))                                # const-string v1, "text/plain"
    emit(0x206e, M_INTENT_SET_TYPE, 0x0013)                      # invoke-virtual {v3, v1}, Intent.setType

    label('attach_extra_text')
    emit(0x011a, S("android.intent.extra.TEXT"))                 # const-string v1, "android.intent.extra.TEXT"
    emit(0x306e, M_INTENT_PUT_STR, 0x0913)                       # invoke-virtual {v3, v1, v9}, Intent.putExtra(String, String)
    emit(0x011a, S("Paper Flow"))                                # const-string v1, "Paper Flow"
    emit(0x2071, M_INTENT_CHOOSER, 0x0013)                       # invoke-static {v3, v1}, Intent.createChooser
    emit(0x030c)                                                 # move-result-object v3
    emit(0x0115, 0x1000)                                         # const/high16 v1, 0x10000000
    emit(0x206e, M_INTENT_SET_FLAGS, 0x0013)                     # invoke-virtual {v3, v1}, Intent.setFlags
    emit(0x6154, F_THIS0)                                        # iget-object v1, v6, this$0
    emit(0x206e, M_START_ACT, 0x0031)                            # invoke-virtual {v1, v3}, MainActivity.startActivity
    emit(0x000e)                                                 # return-void

    # 2. Check legacy text/ share
    label('check_text_share')
    emit(0x011a, S("text/"))                                     # const-string v1, "text/"
    emit(0x206e, M_STR_STARTS, 0x0017)                           # invoke-virtual {v7, v1}, String.startsWith
    emit(0x010a)                                                 # move-result v1
    branch(0x0138, 'not_share')                                  # if-eqz v1, :not_share

    emit(0x001a, S("android.intent.action.SEND"))                # const-string v0, "android.intent.action.SEND"
    emit(0x0322, T("Landroid/content/Intent;"))                  # new-instance v3, Intent
    emit(0x2070, M_INTENT_INIT_ACT, 0x0003)                      # invoke-direct {v3, v0}, Intent.<init>(String)
    emit(0x011a, S("text/plain"))                                # const-string v1, "text/plain"
    emit(0x206e, M_INTENT_SET_TYPE, 0x0013)                      # invoke-virtual {v3, v1}, Intent.setType
    emit(0x011a, S("android.intent.extra.TEXT"))                 # const-string v1, "android.intent.extra.TEXT"
    emit(0x306e, M_INTENT_PUT_STR, 0x0813)                       # invoke-virtual {v3, v1, v8}, Intent.putExtra(String, String)
    emit(0x011a, S("Paper Flow"))                                # const-string v1, "Paper Flow"
    emit(0x2071, M_INTENT_CHOOSER, 0x0013)                       # invoke-static {v3, v1}, Intent.createChooser
    emit(0x030c)                                                 # move-result-object v3
    emit(0x0115, 0x1000)                                         # const/high16 v1, 0x10000000
    emit(0x206e, M_INTENT_SET_FLAGS, 0x0013)                     # invoke-virtual {v3, v1}, Intent.setFlags
    emit(0x6154, F_THIS0)                                        # iget-object v1, v6, this$0
    emit(0x206e, M_START_ACT, 0x0031)                            # invoke-virtual {v1, v3}, MainActivity.startActivity
    emit(0x000e)                                                 # return-void

    # 3. Notification Permission Check + OS Notification Dispatch
    label('not_share')
    emit(0x6054, F_THIS0)                                        # iget-object v0, v6, this$0
    emit(0x0160, F_SDK_INT)                                      # sget v1, Build$VERSION.SDK_INT
    emit(0x0213, 0x0021)                                         # const/16 v2, 33
    branch(0x2134, 'perm_checked')                               # if-lt v1, v2, :perm_checked
    emit(0x011a, S("android.permission.POST_NOTIFICATIONS"))     # const-string v1, "android.permission.POST_NOTIFICATIONS"
    emit(0x206e, M_CHECK_PERM, 0x0010)                           # invoke-virtual {v0, v1}, MainActivity.checkSelfPermission
    emit(0x020a)                                                 # move-result v2
    branch(0x0238, 'perm_checked')                               # if-eqz v2, :perm_checked
    emit(0x1024, T("[Ljava/lang/String;"), 0x0001)               # filled-new-array {v1}, [Ljava/lang/String;
    emit(0x010c)                                                 # move-result-object v1
    emit(0x0213, 0x03ea)                                         # const/16 v2, 1002
    emit(0x306e, M_REQ_PERM, 0x0210)                             # invoke-virtual {v0, v1, v2}, MainActivity.requestPermissions

    label('perm_checked')
    branch(0x0838, 'done_ret')                                   # if-eqz v8, :done_ret
    emit(0x106e, M_STR_EMPTY, 0x0008)                            # invoke-virtual {v8}, String.isEmpty
    emit(0x010a)                                                 # move-result v1
    branch(0x0139, 'done_ret')                                   # if-nez v1, :done_ret

    emit(0x011a, S("notification"))                              # const-string v1, "notification"
    emit(0x206e, M_GET_SYS_SVC, 0x0010)                          # invoke-virtual {v0, v1}, MainActivity.getSystemService
    emit(0x000c)                                                 # move-result-object v0
    emit(0x001f, T("Landroid/app/NotificationManager;"))         # check-cast v0, NotificationManager
    branch(0x0038, 'done_ret')                                   # if-eqz v0, :done_ret

    emit(0x0122, T("Landroid/content/Intent;"))                  # new-instance v1, Intent
    emit(0x6254, F_THIS0)                                        # iget-object v2, v6, this$0
    emit(0x031c, T("Lcom/arnavsri/paperflow/MainActivity;"))     # const-class v3, MainActivity.class
    emit(0x3070, M_INTENT_INIT_CLS, 0x0321)                      # invoke-direct {v1, v2, v3}, Intent.<init>(Context, Class)
    emit(0x0215, 0x2400)                                         # const/high16 v2, 0x24000000
    emit(0x206e, M_INTENT_SET_FLAGS, 0x0021)                     # invoke-virtual {v1, v2}, Intent.setFlags
    emit(0x021a, S("postId"))                                    # const-string v2, "postId"
    emit(0x306e, M_INTENT_PUT_STR, 0x0921)                       # invoke-virtual {v1, v2, v9}, Intent.putExtra

    emit(0x0415, 0x0c00)                                         # const/high16 v4, 0x0c000000
    emit(0x6254, F_THIS0)                                        # iget-object v2, v6, this$0
    emit(0x1071, M_ACCESS_504, 0x0002)                           # invoke-static {v2}, access$504
    emit(0x020a)                                                 # move-result v2
    emit(0x6354, F_THIS0)                                        # iget-object v3, v6, this$0
    emit(0x4071, M_PI_GET_ACT, 0x4123)                           # invoke-static {v3, v2, v1, v4}, PendingIntent.getActivity
    emit(0x040c)                                                 # move-result-object v4

    emit(0x0122, T("Landroid/app/Notification$Builder;"))        # new-instance v1, Notification$Builder
    emit(0x6354, F_THIS0)                                        # iget-object v3, v6, this$0
    emit(0x051a, S("paperflow_alerts"))                          # const-string v5, "paperflow_alerts"
    emit(0x3070, M_NB_INIT, 0x0531)                              # invoke-direct {v1, v3, v5}, Builder.<init>(Context, String)

    emit(0x0315, 0x7f02)                                         # const/high16 v3, 0x7f020000
    emit(0x206e, M_NB_ICON, 0x0031)                              # invoke-virtual {v1, v3}, setSmallIcon
    emit(0x206e, M_NB_TITLE, 0x0071)                             # invoke-virtual {v1, v7}, setContentTitle
    emit(0x206e, M_NB_TEXT, 0x0081)                              # invoke-virtual {v1, v8}, setContentText
    emit(0x1312)                                                 # const/4 v3, 1
    emit(0x206e, M_NB_AUTOCANCEL, 0x0031)                        # invoke-virtual {v1, v3}, setAutoCancel
    emit(0x206e, M_NB_INTENT, 0x0041)                            # invoke-virtual {v1, v4}, setContentIntent
    emit(0x106e, M_NB_BUILD, 0x0001)                             # invoke-virtual {v1}, build
    emit(0x010c)                                                 # move-result-object v1
    emit(0x306e, M_NM_NOTIFY, 0x0120)                            # invoke-virtual {v0, v2, v1}, nm.notify

    try_end_pc = len(asm)
    goto8('done_ret')

    catch_handler_pc = len(asm)
    emit(0x070d)                                                 # move-exception v7
    label('done_ret')
    emit(0x000e)                                                 # return-void

    for pc, target, width in branches:
        rel = labels[target] - pc
        if width == 1:
            assert -128 <= rel <= 127, f"goto8 out of range: {rel}"
            asm[pc] = ((rel & 0xff) << 8) | 0x28
        else:
            assert -32768 <= rel <= 32767, f"branch16 out of range: {rel}"
            asm[pc + 1] = rel & 0xffff

    # Update code_obj for showNotification in parsed_classes
    show_notif_key = ("Lcom/arnavsri/paperflow/MainActivity$AndroidBridge;", ("VLLL", "V", ("Ljava/lang/String;", "Ljava/lang/String;", "Ljava/lang/String;")), "showNotification")
    for cls in parsed_classes:
        if cls['class_type'] == "Lcom/arnavsri/paperflow/MainActivity$AndroidBridge;":
            new_vm = []
            for m_tup, acc, c_obj in cls['v_methods']:
                if m_tup == show_notif_key:
                    c_obj = {
                        'regs': 10,
                        'ins': 4,
                        'outs': 4,
                        'insns': asm,
                        'sym_refs': {},
                        'try_info': (0, try_end_pc, "Ljava/lang/Exception;", catch_handler_pc)
                    }
                new_vm.append((m_tup, acc, c_obj))
            cls['v_methods'] = new_vm

    # Remap all sym_refs in all code_items to new indices
    for cls in parsed_classes:
        for m_list in (cls['d_methods'], cls['v_methods']):
            for _, _, c_obj in m_list:
                if not c_obj:
                    continue
                insns = c_obj['insns']
                for pc, (kind, sym) in c_obj['sym_refs'].items():
                    if kind == 'str':
                        insns[pc + 1] = str_map[sym]
                    elif kind == 'type':
                        insns[pc + 1] = type_map[sym]
                    elif kind == 'field':
                        insns[pc + 1] = field_map[sym]
                    elif kind == 'method':
                        insns[pc + 1] = method_map[sym]

    # Serialize DEX file
    out = bytearray(112)  # Header placeholder

    def align4(buf: bytearray):
        while len(buf) % 4 != 0:
            buf.append(0)

    # Fixed index tables
    s_ids_off = len(out)
    out.extend(b'\x00' * (len(new_strings) * 4))

    t_ids_off = len(out)
    for t in new_types:
        out.extend(struct.pack('<I', str_map[t]))

    p_ids_off = len(out)
    out.extend(b'\x00' * (len(new_protos) * 12))

    f_ids_off = len(out)
    for cl, ty, nm in new_fields:
        out.extend(struct.pack('<HHI', type_map[cl], type_map[ty], str_map[nm]))

    m_ids_off = len(out)
    for cl, pr, nm in new_methods:
        out.extend(struct.pack('<HHI', type_map[cl], proto_map[pr], str_map[nm]))

    c_defs_off = len(out)
    out.extend(b'\x00' * (len(parsed_classes) * 32))

    data_start_off = len(out)

    # 1. TYPE_CODE_ITEM (0x2001)
    align4(out)
    code_sec_off = len(out)
    code_count = 0
    for cls in parsed_classes:
        for m_list in (cls['d_methods'], cls['v_methods']):
            for idx_in_list, (m_tup, acc, c_obj) in enumerate(m_list):
                if not c_obj:
                    c_obj_off = 0
                else:
                    align4(out)
                    c_obj_off = len(out)
                    code_count += 1
                    insns = c_obj['insns']
                    tries = 1 if c_obj['try_info'] else 0
                    out.extend(struct.pack('<HHHHII', c_obj['regs'], c_obj['ins'], c_obj['outs'], tries, 0, len(insns)))
                    for w in insns:
                        out.extend(struct.pack('<H', w))
                    if tries == 1:
                        if len(insns) % 2 == 1:
                            out.extend(b'\x00\x00')
                        s_addr, i_cnt, c_type, c_addr = c_obj['try_info']
                        out.extend(struct.pack('<IHH', s_addr, i_cnt, 1))
                        out.extend(write_uleb128(1))
                        out.extend(write_sleb128(1))
                        out.extend(write_uleb128(type_map[c_type]))
                        out.extend(write_uleb128(c_addr))
                m_list[idx_in_list] = (m_tup, acc, c_obj_off)

    # 2. TYPE_TYPE_LIST (0x1001)
    align4(out)
    type_list_sec_off = len(out)
    type_list_offsets = {}
    type_list_count = 0

    all_type_lists = []
    for _, _, params in new_protos:
        if params and params not in type_list_offsets:
            type_list_offsets[params] = 0
            all_type_lists.append(params)
    for cls in parsed_classes:
        if cls['ifaces'] and cls['ifaces'] not in type_list_offsets:
            type_list_offsets[cls['ifaces']] = 0
            all_type_lists.append(cls['ifaces'])

    for tl in all_type_lists:
        align4(out)
        type_list_offsets[tl] = len(out)
        type_list_count += 1
        out.extend(struct.pack('<I', len(tl)))
        for t_str in tl:
            out.extend(struct.pack('<H', type_map[t_str]))

    # Fill proto_ids table
    for i, (sh, ret, params) in enumerate(new_protos):
        p_off = type_list_offsets.get(params, 0) if params else 0
        struct.pack_into('<III', out, p_ids_off + i * 12, str_map[sh], type_map[ret], p_off)

    # 3. TYPE_STRING_DATA_ITEM (0x2002)
    str_data_sec_off = len(out)
    for i, s in enumerate(new_strings):
        struct.pack_into('<I', out, s_ids_off + i * 4, len(out))
        raw_utf8 = s.encode('utf-8')
        out.extend(write_uleb128(len(s)))
        out.extend(raw_utf8 + b'\x00')

    # 4. TYPE_ANNOTATION_ITEM (0x2004) - @JavascriptInterface
    annot_item_sec_off = len(out)
    js_iface_type_idx = type_map["Landroid/webkit/JavascriptInterface;"]
    out.append(0x01)  # VISIBILITY_RUNTIME
    out.extend(write_uleb128(js_iface_type_idx))
    out.extend(write_uleb128(0))

    # 5. TYPE_CLASS_DATA_ITEM (0x2000)
    class_data_sec_off = len(out)
    class_data_count = 0
    for cls in parsed_classes:
        cls['class_data_off'] = len(out)
        class_data_count += 1
        s_fields = sorted(cls['s_fields'], key=lambda x: field_map[x[0]])
        i_fields = sorted(cls['i_fields'], key=lambda x: field_map[x[0]])
        d_methods = sorted(cls['d_methods'], key=lambda x: method_map[x[0]])
        v_methods = sorted(cls['v_methods'], key=lambda x: method_map[x[0]])

        out.extend(write_uleb128(len(s_fields)))
        out.extend(write_uleb128(len(i_fields)))
        out.extend(write_uleb128(len(d_methods)))
        out.extend(write_uleb128(len(v_methods)))

        prev = 0
        for f_tup, acc in s_fields:
            idx = field_map[f_tup]
            out.extend(write_uleb128(idx - prev))
            out.extend(write_uleb128(acc))
            prev = idx

        prev = 0
        for f_tup, acc in i_fields:
            idx = field_map[f_tup]
            out.extend(write_uleb128(idx - prev))
            out.extend(write_uleb128(acc))
            prev = idx

        prev = 0
        for m_tup, acc, c_off in d_methods:
            idx = method_map[m_tup]
            out.extend(write_uleb128(idx - prev))
            out.extend(write_uleb128(acc))
            out.extend(write_uleb128(c_off))
            prev = idx

        prev = 0
        for m_tup, acc, c_off in v_methods:
            idx = method_map[m_tup]
            out.extend(write_uleb128(idx - prev))
            out.extend(write_uleb128(acc))
            out.extend(write_uleb128(c_off))
            prev = idx

    # 6. TYPE_ANNOTATION_SET_ITEM (0x2006)
    align4(out)
    annot_set_sec_off = len(out)
    out.extend(struct.pack('<II', 1, annot_item_sec_off))

    # 7. TYPE_ANNOTATIONS_DIRECTORY_ITEM (0x1003) for MainActivity$AndroidBridge
    align4(out)
    annot_dir_sec_off = len(out)
    bridge_cls = next(c for c in parsed_classes if c['class_type'] == "Lcom/arnavsri/paperflow/MainActivity$AndroidBridge;")
    bridge_vm_indices = sorted(method_map[m_tup] for m_tup, _, _ in bridge_cls['v_methods'])
    out.extend(struct.pack('<IIII', 0, 0, len(bridge_vm_indices), 0))
    for m_idx in bridge_vm_indices:
        out.extend(struct.pack('<II', m_idx, annot_set_sec_off))

    # Fill class_defs table
    for i, cls in enumerate(parsed_classes):
        if_off = type_list_offsets.get(cls['ifaces'], 0) if cls['ifaces'] else 0
        a_off = annot_dir_sec_off if cls['class_type'] == "Lcom/arnavsri/paperflow/MainActivity$AndroidBridge;" else 0
        struct.pack_into(
            '<IIIIIIII',
            out,
            c_defs_off + i * 32,
            type_map[cls['class_type']],
            cls['access'],
            type_map[cls['super_type']],
            if_off,
            str_map[cls['src_file']],
            a_off,
            cls['class_data_off'],
            0
        )

    # 8. TYPE_MAP_LIST (0x1000)
    align4(out)
    map_off = len(out)
    map_entries = [
        (0x0000, 1, 0),
        (0x0001, len(new_strings), s_ids_off),
        (0x0002, len(new_types), t_ids_off),
        (0x0003, len(new_protos), p_ids_off),
        (0x0004, len(new_fields), f_ids_off),
        (0x0005, len(new_methods), m_ids_off),
        (0x0006, len(parsed_classes), c_defs_off),
        (0x2001, code_count, code_sec_off),
        (0x1001, type_list_count, type_list_sec_off),
        (0x2002, len(new_strings), str_data_sec_off),
        (0x2004, 1, annot_item_sec_off),
        (0x2000, class_data_count, class_data_sec_off),
        (0x2006, 1, annot_set_sec_off),
        (0x1003, 1, annot_dir_sec_off),
        (0x1000, 1, map_off),
    ]
    out.extend(struct.pack('<I', len(map_entries)))
    for m_type, m_size, m_offset in map_entries:
        out.extend(struct.pack('<HHII', m_type, 0, m_size, m_offset))

    file_size = len(out)
    data_size = file_size - data_start_off

    # Fill DEX Header (112 bytes)
    out[0:8] = b'dex\n035\x00'
    struct.pack_into(
        '<IIIIIIIIIIIIIIIIIIII',
        out,
        32,
        file_size,
        112,
        0x12345678,
        0,
        0,
        map_off,
        len(new_strings),
        s_ids_off,
        len(new_types),
        t_ids_off,
        len(new_protos),
        p_ids_off,
        len(new_fields),
        f_ids_off,
        len(new_methods),
        m_ids_off,
        len(parsed_classes),
        c_defs_off,
        data_size,
        data_start_off
    )

    sha1_digest = hashlib.sha1(out[32:]).digest()
    out[12:32] = sha1_digest
    adler = zlib.adler32(out[12:]) & 0xffffffff
    struct.pack_into('<I', out, 8, adler)

    with open(dex_path, 'wb') as f:
        f.write(out)
    print(f"Rebuilt classes.dex ({file_size} bytes) with native Image Snapshot Share (MediaStore/Bitmap) + Android 13+ Notification Permission support!")



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
    download_dir = os.path.join(ROOT_DIR, 'download')
    os.makedirs(download_dir, exist_ok=True)
    shutil.copyfile(signed_apk_path, os.path.join(download_dir, 'Paper-Flow.apk'))
    size = os.path.getsize(os.path.join(ROOT_DIR, 'Paper-Flow.apk'))
    print(f"Paper-Flow.apk successfully built, aligned, signed (v1+v2+v3), and verified: {size} bytes")


if __name__ == '__main__':
    build_apk()
