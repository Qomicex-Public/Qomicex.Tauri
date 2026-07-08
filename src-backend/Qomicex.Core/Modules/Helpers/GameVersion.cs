using Newtonsoft.Json.Linq;
using System.IO.Compression;
using System.Runtime.CompilerServices;
using System.Runtime.Intrinsics.Arm;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

[assembly: InternalsVisibleTo("GeneralHelper")]
namespace Qomicex.Core.Modules.Helpers;
internal static class GameVersion
{
    private const int CONSTANT_UTF8 = 1;
    private const int CONSTANT_INTEGER = 3;
    private const int CONSTANT_FLOAT = 4;
    private const int CONSTANT_LONG = 5;
    private const int CONSTANT_DOUBLE = 6;
    private const int CONSTANT_CLASS = 7;
    private const int CONSTANT_STRING = 8;
    private const int CONSTANT_FIELDREF = 9;
    private const int CONSTANT_METHODREF = 10;
    private const int CONSTANT_INTERFACEMETHODREF = 11;
    private const int CONSTANT_NAMEANDTYPE = 12;
    private const int CONSTANT_METHODHANDLE = 15;
    private const int CONSTANT_METHODTYPE = 16;
    private const int CONSTANT_DYNAMIC = 17;
    private const int CONSTANT_INVOKEDYNAMIC = 18;
    private const int CONSTANT_MODULE = 19;
    private const int CONSTANT_PACKAGE = 20;

    private static readonly Dictionary<string, string> KNOWN_VERSIONS = new()
    {
        { "4df7880d26414b400640f0b8e54344df2b66c51a", "1.0.0-rc1" },
        { "9e04e60eef3fb4657b406dcb3ad5e3a675ecf6af", "1.0.0-rc2-1" },
        { "6a6b67d34149afc47cf9608b3967582639097df9", "1.0.0-rc2-2" },
        { "6e54fbe19b7797f3e3a2cb9feb5da41a40926db8", "1.0.0-rc2-3" },
        { "fe189e91a3e7166d46fad8ce53ba0ce34b4c5f97", "a1.0.5" },
        { "73f569bf5556580979606049204835ae1a54f04d", "a1.0.5_01" },
        { "e5838277b3bb193e58408713f1fc6e005c5f3c0c", "a1.0.4" },
        { "31e9736457ef3e0bfea69c720137a1bd8ba7caae", "a1.0.3" },
        { "4f9ce27cfc6394af533fde11a90b6a233dd908bf", "a1.0.2_02" },
        { "7457e763ad81eee1e63628d628647f53806dab7c", "a1.0.2_01" },
        { "02c57723da508aab36455782904bfd6e3e1023e6", "a1.0.1_01" },
        { "88c1931650b0e5be349017e124a7785a745111e9", "inf-20100630-2" },
        { "121fff417950ad72005ca4d882ca6269e874547b", "inf-20100630-1" },
        { "eb50bce3cb542488b3039aa0f4c3c0ec7595ab24", "inf-20100629" },
        { "4d31259a71c5886b987b9eca6034ca5552079eed", "inf-20100627" },
        { "d9fc6416186e1454945ab135f37c730c7d2c1adc", "inf-20100625-2" },
        { "990b531a26ae8e475032915938763c12cdb2dcf9", "inf-20100625-1" },
        { "644c050e846035e06a6637bffa2afee1e5769c8c", "inf-20100624" },
        { "d3eb1dce5a6c86dd0d6483ba56223276dcf32c30", "inf-20100617-3" },
        { "06641eca013fe5032a5f1a9d1289599f0970a735", "inf-20100617-2" },
        { "89eab2c1a353707cc00f074dffba9cb7a4f5e304", "inf-20100618" },
        { "47518a623da068728b50b4b53436dea4621b7bf8", "inf-20100615" },
        { "421318a554f17463a56a271d08e9597941d066d9", "inf-20100611" },
        { "a9efb36c142bf835d3d410150856dc9ceeaae81b", "inf-20100608" },
        { "7bbf38d53dd47753af266be4e1c5865342a26974", "inf-20100607" },
        { "27010a5137abd2c8d8df85e99c14f5406ec197b3", "inf-20100420" },
        { "a91c9d8e0184eda610213b1a5425fbfa078cb191", "inf-20100415" },
        { "86dd3b1558352b38d4d15c7ec51b9131bd7aed4b", "inf-20100414" },
        { "7b39167f14d9f0ce7af6819433856be7b82d2412", "inf-20100413" },
        { "a74c8ee1ecd57999e242952697bbde6cc0904f99", "inf-20100330" },
        { "47b1b32430a211520993552ba0a5e00c1af44724", "inf-20100327" },
        { "99da3b55b4db292faca59824e3ec76bf53a7eae6", "inf-20100325" },
        { "2c89471a81858d37ab0b01e042131878b6853b38", "inf-20100321" },
        { "7f1c48fc6d61dd0cbfd41b84fb0b0a22944aa02c", "inf-20100320" },
        { "ad7b3cd706098ac05c7dba61dacb40bafcd47db6", "inf-20100316" },
        { "65a00a10001978538ab8eef1a2533f47d4ecbe23", "inf-20100313" },
        { "801ce486bb7fd1b43a56bc5d226dfb1370c08678", "in-20100223" },
        { "af3d7f95ca75e130a9c5c74be0a9c09600a15686", "in-20100219" },
        { "2ba9e9a2bdac1e8af6a36819e9bb01375889b078", "in-20100218" },
        { "dcbe38d0e4ac2caec7e5c0f9ebcb0ec9179dcdff", "in-20100214-2" },
        { "e6bb9306dab60626ba6ffd24fc9742fd272f5acb", "in-20100214-1" },
        { "f1ae7e37e52b33753b35402e581eb65dc5bba877", "in-20100212-2" },
        { "5275aaf68d6388ef8278b575e95ae83ad641fe3e", "in-20100212-1" },
        { "fa8525be5612d00f6001be7d4cdb764b66e88f9d", "in-20100207-2" },
        { "054e3d3f4e2c0463f80aa323767e018e6c23c1cd", "in-20100207-1" },
        { "049b002cdd164e5c5e9b78780b12ab4dc2e80120", "in-20100206-2103" },
        { "b2abb22e001abf01ca7555ced5d6024350955d70", "in-20100203" },
        { "38d4df5132077ac60f0bdf67564f5fff4ee309e2", "in-20100201-3" },
        { "1f2ca31fc761207bcabc07f0cf4b725a9a3286e4", "in-20100201-2" },
        { "c871e820d5356b88b3ad854789162f8b9227c80c", "in-20100130" },
        { "03b858d31c090b629f406aa1d548ac7b25341f02", "in-20100129" },
        { "3f2418f906d438b26ae6c9dbbadf3942f5845504", "in-20100128-2304" },
        { "baf0c7b1e231f0984e1c35e27f38eea2743f8ee2", "in-20100125-2" },
        { "2cd03bcfc26c95bcf31b5d5e1d4dda7dc071ca6a", "in-20100125-1" },
        { "a0b58472ebf12f7e562b09b8a51dcb4cacc57005", "in-20100111-1" },
        { "38958105bfe0f7064b3c4996905cb6978d4d4b0b", "in-20100105" },
        { "3161652a6835c61817fda6fe13245c57528ed418", "in-20091231-2" },
        { "94ee2e7aa7d093fa8dfc684baa8bd8afe002580f", "in-20091223-2" },
        { "54622801f5ef1bcc1549a842c5b04cb5d5583005", "c0.30_01c" },
        { "51bc951530207b538596941a6f353f87dfc24233", "c0.30-2" },
        { "619ea74c6d0ae5c0125d1e31e299105e100139ab", "c0.30-1" },
        { "6a6f92b691f9d6b7ca991a6db8a1cfc6e319815b", "c0.29_02" },
        { "bb5e7f1c231f45fd630f30a75570937c103f5b55", "c0.29_01" },
        { "7ccde270abacd028d3618be99537ccf7071a605b", "c0.28_01" },
        { "aff4060249dd6152012218e120d7aad5e758de83", "c0.27_st" },
        { "349630cb1b895335c38b499f84dc28d9f8a38513", "c0.25_05_st" },
        { "0b387d2087edda894fae4af00de5ac202dbffa7c", "c0.24_st_03" },
        { "85159cea8663ed720be88ca0ee008a5830b0829a", "c0.0.22a_05" },
        { "83b6483feb88136b6b4662b553d8f80f5f88efa5", "c0.0.21a" },
        { "c2f8fddde4691d7c567c0c049ad4d03eb6b9e61c", "c0.0.20a_01" },
        { "e2b248f1013933af9f801729418409fb7198de1b", "c0.0.19a_06-2" },
        { "a78468abd491d6c661c000f60d6270a692ba4710", "c0.0.18a_02" },
        { "ca840460a6589552c9d1978ca121bf3e7c16a010", "c0.0.17a" },
        { "741eb3f84097fdcc0327230e018a0f8cd39addfb", "c0.0.16a_02" },
        { "936d575b1ab1a04a341ad43d76e441e88d2cd987", "c0.0.13a" },
        { "e8aa74a5bee547097375d44ffb2e407b2ea8ee4d", "c0.0.14a_08" },
        { "b9884f960f2b28a36b34db3447963f1ff4058aa4", "c0.0.23a_01" },
        { "7ba9e63aec8a15a99ecd47900c848cdce8a51a03", "c0.0.13a_03" },
        { "501ea8a6274faffe0144d3b24ed56797ce0765ff", "c0.0.12a_03" },
        { "3a799f179b6dcac5f3a46846d687ebbd95856984", "c0.0.11a" },
        { "6323bd14ed7f83852e17ebc8ec418e55c97ddfe4", "rd-161348" },
        { "b100be8097195b6c9112046dc6a80d326c8df839", "rd-160052" },
        { "12dace5a458617d3f90337a7ebde86c0593a6899", "rd-132328" },
        { "393e8d4b4d708587e2accd7c5221db65365e1075", "rd-132211" }
    };


    /// <summary>
    /// 从 JAR 文件读取 Minecraft 版本号
    /// 依次尝试：JAR 内 version.json → Minecraft.class 常量池 → MinecraftServer.class 常量池
    /// </summary>
    public static string? FromJar(string jarPath)
    {
        if (!File.Exists(jarPath))
            return null;

        try
        {
            using var jar = ZipFile.OpenRead(jarPath);

            // 1. 尝试 JAR 内的 version.json（Minecraft 1.14+）
            var versionEntry = jar.GetEntry("version.json");
            if (versionEntry != null)
            {
                var version = FromVersionJson(jar, versionEntry);
                if (version != null)
                    return version;
            }

            // 2. 尝试 Minecraft.class 常量池
            var minecraftClass = jar.GetEntry("net/minecraft/client/Minecraft.class");
            if (minecraftClass != null)
            {
                var version = FromMinecraftClass(jar, minecraftClass);
                if (version != null)
                {
                    // 过滤 RC/Beta/Alpha 的内部标记
                    if (version is "RC1" or "RC2")
                        return null; // 回退到下一个方法
                    if (version.StartsWith("Beta "))
                        return "b" + version["Beta ".Length..];
                    if (version.StartsWith("Alpha v"))
                        return "a" + version["Alpha v".Length..];
                    return version;
                }
            }

            // 3. 尝试 MinecraftServer.class 常量池
            var serverClass = jar.GetEntry("net/minecraft/server/MinecraftServer.class");
            if (serverClass != null)
            {
                var version = FromMinecraftServerClass(jar, serverClass);
                if (version != null)
                    return version;
            }

            // 4. 尝试已知版本号映射
            string hash = string.Empty;
            using (SHA1 sha1 = SHA1.Create())
            {
                byte[] hashBytes = sha1.ComputeHash(File.ReadAllBytes(jarPath));
                hash = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();
            }
            if (KNOWN_VERSIONS.TryGetValue(hash, out var knownVersion))
                return knownVersion;
        }
        catch
        {
            return null;
        }

        return null;
    }

    /// <summary>
    /// 从 JAR 内的 version.json 读取 id 字段
    /// </summary>
    private static string? FromVersionJson(ZipArchive jar, ZipArchiveEntry entry)
    {
        try
        {
            using var stream = entry.Open();
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();

            var obj = JObject.Parse(json);
            var id = obj["id"]?.ToString();
            if (string.IsNullOrEmpty(id))
                return null;

            var slashIndex = id.IndexOf(" / ");
            return slashIndex >= 0 ? id[..slashIndex] : id;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 从 Minecraft.class 常量池中查找 "Minecraft Minecraft X.Y.Z" 字符串
    /// </summary>
    private static string? FromMinecraftClass(ZipArchive jar, ZipArchiveEntry entry)
    {
        try
        {
            using var stream = entry.Open();
            var utf8Strings = ReadConstantPoolUtf8Strings(stream);

            foreach (var str in utf8Strings)
            {
                if (str.StartsWith("Minecraft Minecraft "))
                    return str["Minecraft Minecraft ".Length..];
            }
        }
        catch
        {
            return null;
        }

        return null;
    }

    /// <summary>
    /// 从 MinecraftServer.class 常量池中查找版本号
    /// 策略：找到 "Can't keep up!" 附近最近的版本号格式字符串
    /// </summary>
    private static string? FromMinecraftServerClass(ZipArchive jar, ZipArchiveEntry entry)
    {
        try
        {
            using var stream = entry.Open();
            var utf8Strings = ReadConstantPoolUtf8Strings(stream);

            var canKeepUpIdx = -1;
            for (var i = 0; i < utf8Strings.Count; i++)
            {
                if (utf8Strings[i].StartsWith("Can't keep up!"))
                {
                    canKeepUpIdx = i;
                    break;
                }
            }

            if (canKeepUpIdx < 0)
                return null;

            var versionPattern = new Regex(@"^.*\d.*$");
            for (var i = canKeepUpIdx - 1; i >= 0; i--)
            {
                if (versionPattern.IsMatch(utf8Strings[i]))
                    return utf8Strings[i];
            }
        }
        catch
        {
            return null;
        }

        return null;
    }

    /// <summary>
    /// 解析 Java .class 文件常量池，提取所有 CONSTANT_Utf8 字符串
    /// </summary>
    private static List<string> ReadConstantPoolUtf8Strings(Stream classStream)
    {
        var strings = new List<string>();

        using var reader = new BinaryReader(classStream);

        // Magic number (0xCAFEBABE)
        var magic = ReadU4(reader);
        if (magic != 0xCAFEBABE)
            throw new InvalidDataException("Not a valid Java class file");

        // minor_version, major_version
        var minor = reader.ReadUInt16BigEndian();
        var major = reader.ReadUInt16BigEndian();

        // constant_pool_count
        var poolCount = reader.ReadUInt16BigEndian();

        for (var i = 1; i < poolCount; i++)
        {
            var tag = reader.ReadByte();

            switch (tag)
            {
                case CONSTANT_UTF8:
                    var length = reader.ReadUInt16BigEndian();
                    var bytes = reader.ReadBytes(length);
                    strings.Add(System.Text.Encoding.UTF8.GetString(bytes));
                    break;

                case CONSTANT_INTEGER:
                case CONSTANT_FLOAT:
                    reader.ReadBytes(4);
                    break;

                case CONSTANT_LONG:
                case CONSTANT_DOUBLE:
                    reader.ReadBytes(8);
                    i++; // Long 和 Double 占用两个常量池索引
                    break;

                case CONSTANT_CLASS:
                case CONSTANT_STRING:
                case CONSTANT_METHODTYPE:
                case CONSTANT_MODULE:
                case CONSTANT_PACKAGE:
                    reader.ReadBytes(2);
                    break;

                case CONSTANT_FIELDREF:
                case CONSTANT_METHODREF:
                case CONSTANT_INTERFACEMETHODREF:
                case CONSTANT_NAMEANDTYPE:
                case CONSTANT_DYNAMIC:
                case CONSTANT_INVOKEDYNAMIC:
                    reader.ReadBytes(4);
                    break;

                case CONSTANT_METHODHANDLE:
                    reader.ReadBytes(3);
                    break;

                default:
                    throw new InvalidDataException($"Unknown constant pool tag: {tag}");
            }
        }

        return strings;
    }

    private static uint ReadU4(BinaryReader reader)
    {
        var bytes = reader.ReadBytes(4);
        return ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
    }

    private static ushort ReadUInt16BigEndian(this BinaryReader reader)
    {
        var bytes = reader.ReadBytes(2);
        return (ushort)((bytes[0] << 8) | bytes[1]);
    }
}
