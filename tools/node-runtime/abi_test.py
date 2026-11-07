import importlib.util
import pathlib
import re
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('node_runtime_abi', pathlib.Path(__file__).parent / 'abi.py')
abi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abi)


class NodeRuntimeAbiTest(unittest.TestCase):
    @staticmethod
    def header(machine=62, kind=3):
        value=bytearray(20);value[:7]=b'\x7fELF\x02\x01\x01'
        value[16:18]=kind.to_bytes(2,'little');value[18:20]=machine.to_bytes(2,'little')
        return bytes(value)

    def test_architecture_bound_loader_is_an_allowed_glibc_dependency(self):
        for machine,(architecture,loader) in abi.LOADERS.items():
            with self.subTest(architecture=architecture):
                dynamic='(NEEDED) Shared library: [libc.so.6]\n(NEEDED) Shared library: ['+loader.rsplit('/',1)[1]+']'
                result=abi.elf_layout(self.header(machine),'[Requesting program interpreter: '+loader+']',dynamic)
                self.assertEqual(result['architecture'],architecture);self.assertEqual(result['interpreter'],loader)
                self.assertIsNone(abi.elf_layout(self.header(machine),'',dynamic,False)['interpreter'])

    def test_wrong_architecture_or_loader_and_local_search_path_are_denied(self):
        loader=abi.LOADERS[62][1];programs='[Requesting program interpreter: '+loader+']'
        for header,interp,dynamic in [
                (self.header(183),programs,'(NEEDED) [libc.so.6]'),
                (self.header(),programs,'(NEEDED) [ld-linux-aarch64.so.1]'),
                (self.header(),programs,'(NEEDED) [libunreviewed.so]'),
                (self.header(),programs,'(NEEDED) [libc.so.6]\n(RUNPATH) [/tmp/local]'),
                (self.header(),programs,'(NEEDED) [libc.so.6]\n(NEEDED) [libc.so.6]'),
                (self.header(),'[Requesting program interpreter: /tmp/ld-linux-x86-64.so.2]','(NEEDED) [libc.so.6]'),
                (self.header(42),programs,'(NEEDED) [libc.so.6]'),
                (self.header(kind=1),programs,'(NEEDED) [libc.so.6]'),
                (self.header()[:4]+b'\x01'+self.header()[5:],programs,'(NEEDED) [libc.so.6]'),
                (self.header()[:5]+b'\x02'+self.header()[6:],programs,'(NEEDED) [libc.so.6]')]:
            with self.subTest(header=header,interpreter=interp,dynamic=dynamic),self.assertRaises(ValueError):
                abi.elf_layout(header,interp,dynamic)

    def test_addon_is_a_shared_object_without_an_interpreter(self):
        for header,programs in [(self.header(kind=2),''),(self.header(),'[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]')]:
            with self.subTest(header=header,programs=programs),self.assertRaises(ValueError):
                abi.elf_layout(header,programs,'(NEEDED) [libc.so.6]',False)

    def test_node_and_addon_must_have_the_same_architecture(self):
        with mock.patch.object(abi.sys,'argv',['abi.py','node','addon','unused-output']),\
             mock.patch.object(abi,'inspect',side_effect=[{'architecture':'x64'},{'architecture':'arm64'}]),\
             self.assertRaisesRegex(ValueError,'architectures differ'):
            abi.main()

    def test_supported_requirements_ignore_exported_definitions(self):
        self.assertEqual(abi.check_versions('Version definition section\n Name: GLIBC_9.99\n'
            'Version needs section\n Name: GLIBC_2.28\n Name: GLIBC_2.2.5\n Name: GLIBCXX_3.4.25\n'
            ' Name: CXXABI_1.3.11\n Name: GCC_3.0\n'),
            {'GLIBC': '2.28', 'GLIBCXX': '3.4.25', 'CXXABI': '1.3.11'})

    def test_new_or_unknown_runtime_requirements_fail(self):
        for name in ['GLIBC_2.29', 'GLIBC_2.36', 'GLIBCXX_3.4.26', 'CXXABI_1.3.12',
                     'GLIBC_PRIVATE', 'GLIBC_ABI_DT_RELR', 'OTHER_1.0', 'GCC_9.0']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                abi.check_versions('Version needs section\n Name: GLIBC_2.28\n Name: ' + name)

    def test_native_followup_length_matches_both_verifiers(self):
        root = pathlib.Path(__file__).parent
        native = re.search(r'gzprintf\(file, "%s", "([a-z -]+)"\)', (root / 'gzwrite-probe.c').read_text()).group(1)
        for name in ['verify.mjs', 'compatibility.mjs']:
            source = (root / name).read_text()
            expectation = re.search(r'assert.equal\((?:native\.)?result.followupBytes, Buffer.byteLength\(\'([^\']+)\'\)\)', source).group(1)
            self.assertEqual(expectation.encode(), native.encode(), name)
            self.assertEqual(len(expectation.encode()), 19)

    def test_missing_requirements_fail(self):
        for text in ['', 'Name: GLIBC_2.28', 'Version needs section',
                     'Version needs section\n Name: GLIBCXX_3.4.25']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                abi.check_versions(text)


if __name__ == '__main__':
    unittest.main()
