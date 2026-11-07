import importlib.util
import pathlib
import re
import unittest

spec = importlib.util.spec_from_file_location('node_runtime_abi', pathlib.Path(__file__).parent / 'abi.py')
abi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abi)


class NodeRuntimeAbiTest(unittest.TestCase):
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
