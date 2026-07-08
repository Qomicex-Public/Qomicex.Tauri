using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class Mods : CurseForgeBase
    {
        public Mods(string ApiKey) : base(ApiKey, GetSearchUrl(), GetModUrl()) { }
        private static string GetSearchUrl()
        {
            return "/v1/mods/search?gameId=432&classId=6";
        }

        private static string GetModUrl()
        {
            return "/v1/mods/";
        }

        /// <summary>
        /// 获取推荐的Mod列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="ModLoaderTypes">模组加载器</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        public async Task<List<CurseForgeSearchResult>> GetRecommendMods(string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.GetRecommend(GameVersions, Categories, ModLoaderTypes, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的Mod
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="ModLoaderTypes">ModLoader类型</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        public new async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.SearchAsync(SearchFilter, GameVersions, Categories, ModLoaderTypes, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步获取指定Mod的详细信息
        /// </summary>
        /// <param name="ModId">ModId</param>
        /// <returns>Mod信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<CurseForgeInfo> GetModInfoAsync(string ModId)
        {
            return await base.GetInfoAsync(ModId);
        }


        public enum Category
        {
            Food = 436,
            OresAndResources = 408,
            Miscellaneous = 425,
            ThermalExpansion = 427,
            Cosmetic = 424,
            Education = 5299,
            Buildcraft = 432,
            Processing = 413,
            TinkersConstruct = 428,
            MapAndInformation = 423,
            IndustrialCraft = 429,
            Farming = 416,
            Technology = 412,
            Genetics = 418,
            Structures = 409,
            Mobs = 411,
            Magic = 419,
            Addons = 426,
            Dimensions = 410,
            ArmorAndToolsAndAndWeapons = 434,
            WorldGen = 406,
            ServerUtility = 435,
            EnergyAndFluidAndAndItemTransport = 415,
            AppliedEnergistics2 = 4545,
            PlayerTransport = 414,
            Energy = 417,
            Biomes = 407,
            AdventureAndRpg = 422,
            Forestry = 433,
            ApiAndLibrary = 421,
            Storage = 420,
            Redstone = 4558,
            BloodMagic = 4485,
            ThaumCraft = 430,
            Automation = 4843,
            TwitchIntegration = 4671,
            CraftTweaker = 4773,
            Mcreator = 4906,
            Kubejs = 5314,
            UtilityAndQol = 5191,
            Galacticraft = 5232,
            Skyblock = 6145,
            Create = 6484,
            IntegratedDynamics = 6954,
            Performance = 6814,
            BugFixes = 6821,
            TwilightForest = 7669,
        }
    }
}
