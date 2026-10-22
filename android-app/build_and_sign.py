#!/usr/bin/env python3
import os
import sys
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
PUBKEY_DER = os.path.join(BASE_DIR, 'pubkey.der')

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
    subprocess.run(['openssl', 'x509', '-in', CERT_FILE, '-noout', '-pubkey'], stdout=open(os.path.join(BASE_DIR, 'pubkey.pem'), 'w'), check=True)
    subprocess.run(['openssl', 'rsa', '-pubin', '-in', os.path.join(BASE_DIR, 'pubkey.pem'), '-outform', 'DER', '-out', PUBKEY_DER], check=True)

def build_apk():
    ensure_keys()
    src_apk = os.path.join(ROOT_DIR, 'Paper-Flow.apk')
    work_dir = '/tmp/apk_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir, exist_ok=True)

    # Extract source apk
    with zipfile.ZipFile(src_apk, 'r') as z:
        for member in z.infolist():
            if not member.filename.startswith('META-INF/'):
                z.extract(member, work_dir)

    # Update assets/www/index.html with root index.html
    root_index = os.path.join(ROOT_DIR, 'index.html')
    target_index = os.path.join(work_dir, 'assets', 'www', 'index.html')
    os.makedirs(os.path.dirname(target_index), exist_ok=True)
    shutil.copyfile(root_index, target_index)

    # Compute V1 manifest entries
    manifest_entries = []
    file_list = []
    for root, _, files in os.walk(work_dir):
        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, work_dir).replace('\\', '/')
            file_list.append((rel_path, full_path))

    file_list.sort(key=lambda x: x[0])

    manifest_lines = ['Manifest-Version: 1.0\r\n\r\n']
    sf_lines = ['Signature-Version: 1.0\r\nCreated-By: 1.0 (Android)\r\nX-Android-APK-Signed: 2, 3\r\n']

    for rel_path, full_path in file_list:
        with open(full_path, 'rb') as fp:
            data = fp.read()
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode('ascii')
        entry_str = f"Name: {rel_path}\r\nSHA-256-Digest: {digest}\r\n\r\n"
        manifest_lines.append(entry_str)

    manifest_bytes = "".join(manifest_lines).encode('utf-8')
    manifest_digest = base64.b64encode(hashlib.sha256(manifest_bytes).digest()).decode('ascii')
    sf_lines.append(f"SHA-256-Digest-Manifest: {manifest_digest}\r\n\r\n")

    for rel_path, full_path in file_list:
        with open(full_path, 'rb') as fp:
            data = fp.read()
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode('ascii')
        manifest_entry = f"Name: {rel_path}\r\nSHA-256-Digest: {digest}\r\n\r\n".encode('utf-8')
        sf_digest = base64.b64encode(hashlib.sha256(manifest_entry).digest()).decode('ascii')
        sf_lines.append(f"Name: {rel_path}\r\nSHA-256-Digest: {sf_digest}\r\n\r\n")

    sf_bytes = "".join(sf_lines).encode('utf-8')

    # Sign SF with openssl CMS
    meta_dir = os.path.join(work_dir, 'META-INF')
    os.makedirs(meta_dir, exist_ok=True)
    with open(os.path.join(meta_dir, 'MANIFEST.MF'), 'wb') as f:
        f.write(manifest_bytes)
    with open(os.path.join(meta_dir, 'PAPERFLO.SF'), 'wb') as f:
        f.write(sf_bytes)

    rsa_path = os.path.join(meta_dir, 'PAPERFLO.RSA')
    subprocess.run([
        'openssl', 'cms', '-sign', '-nodetach', '-binary',
        '-in', os.path.join(meta_dir, 'PAPERFLO.SF'),
        '-signer', CERT_FILE, '-inkey', KEY_FILE,
        '-outform', 'DER', '-out', rsa_path
    ], check=True, stderr=subprocess.PIPE)

    # Build unaligned zip in memory/temp file
    temp_zip = '/tmp/unaligned.apk'
    with zipfile.ZipFile(temp_zip, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        # First META-INF
        for name in ['MANIFEST.MF', 'PAPERFLO.SF', 'PAPERFLO.RSA']:
            p = os.path.join(meta_dir, name)
            zf.write(p, f'META-INF/{name}', compress_type=zipfile.ZIP_DEFLATED)
        # Then all other files
        for rel_path, full_path in file_list:
            # Uncompressed for resources.arsc and images if needed, or deflated
            compress = zipfile.ZIP_STORED if rel_path.endswith('.png') or rel_path.endswith('.arsc') else zipfile.ZIP_DEFLATED
            zf.write(full_path, rel_path, compress_type=compress)

    # Now build aligned APK with APK v2 signature scheme
    aligned_apk = '/tmp/signed_v2.apk'
    sign_v2(temp_zip, aligned_apk)

    # Place in root and public
    shutil.copyfile(aligned_apk, os.path.join(ROOT_DIR, 'Paper-Flow.apk'))
    shutil.copyfile(aligned_apk, os.path.join(ROOT_DIR, 'public', 'Paper-Flow.apk'))
    size = os.path.getsize(os.path.join(ROOT_DIR, 'Paper-Flow.apk'))
    print(f"Paper-Flow.apk successfully built and signed: {size} bytes")

def sign_v2(in_zip_path, out_apk_path):
    # Read entire in_zip
    with open(in_zip_path, 'rb') as f:
        zip_data = f.read()

    # Find Central Directory offset
    # End of Central Directory Record is last 22+ bytes
    eocd_idx = zip_data.rfind(b'\x50\x4b\x05\x06')
    if eocd_idx == -1:
        raise ValueError("Invalid ZIP file")

    cd_size = struct.unpack('<I', zip_data[eocd_idx + 12:eocd_idx + 16])[0]
    cd_offset = struct.unpack('<I', zip_data[eocd_idx + 16:eocd_idx + 20])[0]

    sec1 = zip_data[:cd_offset]
    sec2 = zip_data[cd_offset:cd_offset + cd_size]
    sec3_before = zip_data[eocd_idx:]

    # Compute 1MB chunk digests
    def compute_section_digests(data):
        chunk_digests = []
        chunk_size = 1048576 # 1MB
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + chunk_size]
            h = hashlib.sha256(b'\xa5' + struct.pack('<I', len(chunk)) + chunk).digest()
            chunk_digests.append(h)
            offset += chunk_size
        return chunk_digests

    digests1 = compute_section_digests(sec1)
    digests2 = compute_section_digests(sec2)

    # Temporary sec3 with adjusted cd_offset placeholder for digest
    # In APK v2 spec, sec3 has the CD offset updated to cd_offset
    # (before inserting signing block)
    sec3_temp = bytearray(sec3_before)
    struct.pack_into('<I', sec3_temp, 16, cd_offset)
    digests3 = compute_section_digests(bytes(sec3_temp))

    all_digests = b''.join(digests1 + digests2 + digests3)
    top_digest = hashlib.sha256(b'\x5a' + struct.pack('<I', len(digests1) + len(digests2) + len(digests3)) + all_digests).digest()

    cert_bytes = open(CERT_DER, 'rb').read()
    pubkey_bytes = open(PUBKEY_DER, 'rb').read()

    # Build SignedData
    # list of digests
    # algo ID 0x0103 = SHA256withRSA
    digest_entry = struct.pack('<I', 0x0103) + struct.pack('<I', len(top_digest)) + top_digest
    digest_list = struct.pack('<I', len(digest_entry) + 4) + struct.pack('<I', len(digest_entry)) + digest_entry

    # list of certs
    cert_entry = struct.pack('<I', len(cert_bytes)) + cert_bytes
    cert_list = struct.pack('<I', len(cert_entry) + 4) + struct.pack('<I', len(cert_entry)) + cert_entry

    # additional attributes
    attr_list = struct.pack('<I', 0)

    signed_data = (
        struct.pack('<I', len(digest_list)) + digest_list +
        struct.pack('<I', len(cert_list)) + cert_list +
        struct.pack('<I', len(attr_list)) + attr_list
    )

    # Sign signed_data with RSA key using openssl
    with open('/tmp/sd.bin', 'wb') as f:
        f.write(signed_data)
    subprocess.run([
        'openssl', 'dgst', '-sha256', '-sign', KEY_FILE,
        '-out', '/tmp/sig.bin', '/tmp/sd.bin'
    ], check=True)
    sig_bytes = open('/tmp/sig.bin', 'rb').read()

    # Signature entry
    sig_entry = struct.pack('<I', 0x0103) + struct.pack('<I', len(sig_bytes)) + sig_bytes
    sig_list = struct.pack('<I', len(sig_entry) + 4) + struct.pack('<I', len(sig_entry)) + sig_entry

    # Signer
    signer_data = (
        struct.pack('<I', len(signed_data)) + signed_data +
        struct.pack('<I', len(sig_list)) + sig_list +
        struct.pack('<I', len(pubkey_bytes)) + pubkey_bytes
    )
    signer_list = struct.pack('<I', len(signer_data) + 4) + struct.pack('<I', len(signer_data)) + signer_data

    # v2 block
    v2_pair_val = struct.pack('<I', len(signer_list) + 4) + struct.pack('<I', len(signer_list)) + signer_list
    v2_pair = struct.pack('<Q', len(v2_pair_val) + 4) + struct.pack('<I', 0x7109871a) + v2_pair_val

    # Align block size to multiple of 4096 (standard android zipalign block size)
    content_len = len(v2_pair)
    # Total block size = 8 (size) + content_len + padding + 8 (size) + 16 (magic)
    # We want total_len % 4096 == 0
    rem = (content_len + 32) % 4096
    pad_len = (4096 - rem) % 4096
    if pad_len > 0:
        if pad_len >= 12:
            pad_val = b'\x00' * (pad_len - 12)
            pad_pair = struct.pack('<Q', len(pad_val) + 4) + struct.pack('<I', 0x42726577) + pad_val
        else:
            pad_val = b'\x00' * (pad_len + 4096 - 12)
            pad_pair = struct.pack('<Q', len(pad_val) + 4) + struct.pack('<I', 0x42726577) + pad_val
    else:
        pad_pair = b''

    pairs = v2_pair + pad_pair
    block_size = len(pairs) + 24
    apk_sig_block = (
        struct.pack('<Q', block_size) +
        pairs +
        struct.pack('<Q', block_size) +
        b'APK Sig Block 42'
    )

    # Adjust sec3 with new cd_offset
    new_cd_offset = cd_offset + len(apk_sig_block)
    sec3_final = bytearray(sec3_before)
    struct.pack_into('<I', sec3_final, 16, new_cd_offset)

    with open(out_apk_path, 'wb') as f:
        f.write(sec1)
        f.write(apk_sig_block)
        f.write(sec2)
        f.write(sec3_final)

if __name__ == '__main__':
    build_apk()
