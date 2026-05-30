#include "UEMatExportMetadataCommandlet.h"

#include "HAL/FileManager.h"
#include "Materials/MaterialExpression.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Policies/PrettyJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEMatExportMetadataCommandlet)

namespace UE::MatExportMetadata
{
static const TSet<FString> DynamicNodeTypes =
{
    TEXT("Custom"),
    TEXT("SetMaterialAttributes"),
    TEXT("GetMaterialAttributes"),
    TEXT("LandscapeLayerBlend")
};

static TMap<FString, FString> BuildClassOverrides()
{
    TMap<FString, FString> Overrides;
    Overrides.Add(TEXT("Lerp"), TEXT("MaterialExpressionLinearInterpolate"));
    Overrides.Add(TEXT("TextureSampleParameterMovie"), TEXT("MaterialExpressionTextureSampleParameter2D"));
    Overrides.Add(TEXT("LandscapeLayerBlend"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerBlend"));
    Overrides.Add(TEXT("LandscapeLayerCoords"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerCoords"));
    Overrides.Add(TEXT("LandscapeLayerSwitch"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerSwitch"));
    Overrides.Add(TEXT("LandscapeLayerWeight"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerWeight"));
    Overrides.Add(TEXT("LandscapeVisibilityMask"), TEXT("/Script/Landscape.MaterialExpressionLandscapeVisibilityMask"));
    Overrides.Add(TEXT("PreSkinnedLocalNormal"), TEXT("MaterialExpressionPreSkinnedNormal"));
    Overrides.Add(TEXT("PreSkinnedLocalPosition"), TEXT("MaterialExpressionPreSkinnedPosition"));
    return Overrides;
}

static TMap<FString, FString> BuildFunctionAssetOverrides()
{
    TMap<FString, FString> Overrides;
    Overrides.Add(
        TEXT("BlendAngleCorrectedNormals"),
        TEXT("/Engine/Functions/Engine_MaterialFunctions02/Utility/BlendAngleCorrectedNormals.BlendAngleCorrectedNormals"));
    return Overrides;
}

static TMap<FString, TMap<FString, FString>> BuildInputOverrides()
{
    TMap<FString, TMap<FString, FString>> Overrides;
    Overrides.Add(TEXT("TextureSampleParameter2D"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSample"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSampleParameterSubUV"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("TextureSampleParameterCube"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSampleParameterMovie"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("ParticleSubUV"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("AntialiasedTextureMask"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("Power"), {{TEXT("Exp"), TEXT("Exponent")}});
    Overrides.Add(TEXT("DepthFade"), {{TEXT("Opacity"), TEXT("InOpacity")}});
    Overrides.Add(TEXT("If"), {{TEXT("A > B"), TEXT("AGreaterThanB")}, {TEXT("A = B"), TEXT("AEqualsB")}, {TEXT("A < B"), TEXT("ALessThanB")}});
    Overrides.Add(TEXT("FeatureLevelSwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("ES2"), TEXT("Inputs(0)")}, {TEXT("ES3.1"), TEXT("Inputs(1)")}, {TEXT("SM4"), TEXT("Inputs(2)")}, {TEXT("SM5"), TEXT("Inputs(3)")}});
    Overrides.Add(TEXT("QualitySwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("Low"), TEXT("Inputs(0)")}, {TEXT("High"), TEXT("Inputs(1)")}});
    return Overrides;
}

static TMap<FString, TMap<FString, FString>> BuildParamPropertyOverrides()
{
    TMap<FString, TMap<FString, FString>> Overrides;
    Overrides.Add(TEXT("Transform"), {{TEXT("Source"), TEXT("TransformSourceType")}, {TEXT("Destination"), TEXT("TransformType")}});
    Overrides.Add(TEXT("TransformPosition"), {{TEXT("Source"), TEXT("TransformSourceType")}, {TEXT("Destination"), TEXT("TransformType")}});
    return Overrides;
}

static TMap<FString, FString> BuildSamplerTypeMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Color"), TEXT("SAMPLERTYPE_Color"));
    Map.Add(TEXT("LinearColor"), TEXT("SAMPLERTYPE_LinearColor"));
    Map.Add(TEXT("Grayscale"), TEXT("SAMPLERTYPE_Grayscale"));
    Map.Add(TEXT("LinearGrayscale"), TEXT("SAMPLERTYPE_LinearGrayscale"));
    Map.Add(TEXT("Normal"), TEXT("SAMPLERTYPE_Normal"));
    Map.Add(TEXT("Alpha"), TEXT("SAMPLERTYPE_Alpha"));
    Map.Add(TEXT("Masks"), TEXT("SAMPLERTYPE_Masks"));
    Map.Add(TEXT("Data"), TEXT("SAMPLERTYPE_Data"));
    Map.Add(TEXT("External"), TEXT("SAMPLERTYPE_External"));
    Map.Add(TEXT("VirtualColor"), TEXT("SAMPLERTYPE_VirtualColor"));
    return Map;
}

static TMap<FString, FString> BuildTransformSourceMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Tangent"), TEXT("TRANSFORMSOURCE_Tangent"));
    Map.Add(TEXT("Local"), TEXT("TRANSFORMSOURCE_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORMSOURCE_World"));
    Map.Add(TEXT("View"), TEXT("TRANSFORMSOURCE_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORMSOURCE_Camera"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORMSOURCE_ParticleWorld"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORMSOURCE_ParticleWorld"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORMSOURCE_Instance"));
    return Map;
}

static TMap<FString, FString> BuildTransformDestinationMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Tangent"), TEXT("TRANSFORM_Tangent"));
    Map.Add(TEXT("Local"), TEXT("TRANSFORM_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORM_World"));
    Map.Add(TEXT("View"), TEXT("TRANSFORM_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORM_Camera"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORM_ParticleWorld"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORM_ParticleWorld"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORM_Instance"));
    return Map;
}

static TMap<FString, FString> BuildTransformPositionMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Local"), TEXT("TRANSFORMPOSSOURCE_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORMPOSSOURCE_World"));
    Map.Add(TEXT("AbsoluteWorld"), TEXT("TRANSFORMPOSSOURCE_World"));
    Map.Add(TEXT("PeriodicWorld"), TEXT("TRANSFORMPOSSOURCE_PeriodicWorld"));
    Map.Add(TEXT("TranslatedWorld"), TEXT("TRANSFORMPOSSOURCE_TranslatedWorld"));
    Map.Add(TEXT("CameraRelativeWorld"), TEXT("TRANSFORMPOSSOURCE_TranslatedWorld"));
    Map.Add(TEXT("FirstPersonTranslatedWorld"), TEXT("TRANSFORMPOSSOURCE_FirstPersonTranslatedWorld"));
    Map.Add(TEXT("View"), TEXT("TRANSFORMPOSSOURCE_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORMPOSSOURCE_Camera"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORMPOSSOURCE_Particle"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORMPOSSOURCE_Particle"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORMPOSSOURCE_Instance"));
    return Map;
}

static void SetValueMapFromPairs(TSharedRef<FJsonObject> ParamMeta, const TMap<FString, FString>& Pairs)
{
    TSharedRef<FJsonObject> ValueMap = MakeShared<FJsonObject>();
    for (const TPair<FString, FString>& Pair : Pairs)
    {
        ValueMap->SetStringField(Pair.Key, Pair.Value);
    }
    ParamMeta->SetObjectField(TEXT("valueMap"), ValueMap);
}

static FString ToAbsolutePath(const FString& Path)
{
    return FPaths::ConvertRelativePathToFull(Path);
}

static bool LoadJsonFile(const FString& Path, TSharedPtr<FJsonObject>& OutObject, FString& OutError)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Path))
    {
        OutError = FString::Printf(TEXT("Failed to read JSON file: %s"), *Path);
        return false;
    }

    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
    if (!FJsonSerializer::Deserialize(Reader, OutObject) || !OutObject.IsValid())
    {
        OutError = FString::Printf(TEXT("Failed to parse JSON file: %s"), *Path);
        return false;
    }

    return true;
}

static FString JsonStringField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName, const FString& DefaultValue = TEXT(""))
{
    if (!Object.IsValid())
    {
        return DefaultValue;
    }

    FString Value;
    return Object->TryGetStringField(FieldName, Value) ? Value : DefaultValue;
}

static TArray<TSharedPtr<FJsonValue>> JsonArrayField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
    if (Object.IsValid() && Object->TryGetArrayField(FieldName, Array) && Array != nullptr)
    {
        return *Array;
    }
    return {};
}

static TArray<FString> JsonStringArrayField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    TArray<FString> Result;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(Object, FieldName))
    {
        FString StringValue;
        if (Value.IsValid() && Value->TryGetString(StringValue))
        {
            Result.Add(StringValue);
        }
    }
    return Result;
}

static TArray<FString> ReadNamesFromArray(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    TArray<FString> Names;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(Object, FieldName))
    {
        const TSharedPtr<FJsonObject> Item = Value.IsValid() ? Value->AsObject() : nullptr;
        const FString Name = JsonStringField(Item, TEXT("name"));
        if (!Name.IsEmpty())
        {
            Names.Add(Name);
        }
    }
    return Names;
}

static TMap<FString, TSharedPtr<FJsonObject>> ReadParamObjects(const TSharedPtr<FJsonObject>& NodeObject)
{
    TMap<FString, TSharedPtr<FJsonObject>> Params;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(NodeObject, TEXT("params")))
    {
        const TSharedPtr<FJsonObject> Item = Value.IsValid() ? Value->AsObject() : nullptr;
        const FString Name = JsonStringField(Item, TEXT("name"));
        if (!Name.IsEmpty())
        {
            Params.Add(Name, Item);
        }
    }
    return Params;
}

static UClass* ResolveExpressionClass(const FString& NodeType)
{
    static const TMap<FString, FString> ClassOverrides = BuildClassOverrides();

    TArray<FString> ClassPaths;
    if (const FString* Override = ClassOverrides.Find(NodeType))
    {
        if (Override->StartsWith(TEXT("/Script/")))
        {
            ClassPaths.Add(*Override);
        }
        else
        {
            ClassPaths.Add(FString::Printf(TEXT("/Script/Engine.%s"), **Override));
        }
    }
    ClassPaths.Add(FString::Printf(TEXT("/Script/Engine.MaterialExpression%s"), *NodeType));

    for (const FString& ClassPath : ClassPaths)
    {
        if (UClass* Class = FindObject<UClass>(nullptr, *ClassPath))
        {
            if (Class->IsChildOf(UMaterialExpression::StaticClass()))
            {
                return Class;
            }
        }
        if (UClass* Class = LoadObject<UClass>(nullptr, *ClassPath))
        {
            if (Class->IsChildOf(UMaterialExpression::StaticClass()))
            {
                return Class;
            }
        }
    }

    return nullptr;
}

static FString PropertyNameForInput(UMaterialExpression* Expression, int32 InputIndex, TMap<FString, int32>& PropertyOccurrences)
{
    TArray<FProperty*> Properties = Expression->GetInputPinProperty(InputIndex);
    if (Properties.Num() == 0 || Properties[0] == nullptr)
    {
        return Expression->GetInputName(InputIndex).ToString();
    }

    const FProperty* Property = Properties[0];
    FString PropertyName = Property->GetName();

    if (Property->ArrayDim > 1)
    {
        int32& Occurrence = PropertyOccurrences.FindOrAdd(PropertyName);
        PropertyName += FString::Printf(TEXT("(%d)"), Occurrence);
        ++Occurrence;
    }

    return PropertyName;
}

static TMap<FString, FString> BuildDisplayInputMap(UMaterialExpression* Expression)
{
    TMap<FString, FString> Map;
    TMap<FString, int32> PropertyOccurrences;

    for (int32 InputIndex = 0; Expression->GetInput(InputIndex) != nullptr; ++InputIndex)
    {
        const FString InputName = Expression->GetInputName(InputIndex).ToString();
        if (!InputName.IsEmpty())
        {
            Map.Add(InputName, PropertyNameForInput(Expression, InputIndex, PropertyOccurrences));
        }
    }

    return Map;
}

static bool ClassHasProperty(UClass* Class, const FString& PropertyName)
{
    const FString BaseProperty = PropertyName.LeftChop(PropertyName.EndsWith(TEXT(")") ) ? PropertyName.Len() - PropertyName.Find(TEXT("(")) : 0);
    return Class != nullptr && Class->FindPropertyByName(*(!BaseProperty.IsEmpty() ? BaseProperty : PropertyName)) != nullptr;
}

static FString ResolveInputProperty(const FString& NodeType, const FString& PinName, UClass* Class, UMaterialExpression* Expression)
{
    static const TMap<FString, TMap<FString, FString>> InputOverrides = BuildInputOverrides();
    if (const TMap<FString, FString>* NodeOverrides = InputOverrides.Find(NodeType))
    {
        if (const FString* Override = NodeOverrides->Find(PinName))
        {
            return *Override;
        }
    }

    if (ClassHasProperty(Class, PinName))
    {
        return PinName;
    }

    if (Expression != nullptr)
    {
        const TMap<FString, FString> DisplayMap = BuildDisplayInputMap(Expression);
        if (const FString* Property = DisplayMap.Find(PinName))
        {
            return *Property;
        }
    }

    return ClassHasProperty(Class, PinName) ? PinName : PinName;
}

static FString ResolveParamProperty(const FString& NodeType, const FString& ParamName)
{
    static const TMap<FString, TMap<FString, FString>> ParamOverrides = BuildParamPropertyOverrides();
    if (const TMap<FString, FString>* NodeOverrides = ParamOverrides.Find(NodeType))
    {
        if (const FString* Override = NodeOverrides->Find(ParamName))
        {
            return *Override;
        }
    }
    return ParamName;
}

static FString KindForParamType(const FString& Type)
{
    if (Type == TEXT("Float")) return TEXT("float");
    if (Type == TEXT("Int")) return TEXT("int");
    if (Type == TEXT("Bool")) return TEXT("bool");
    if (Type == TEXT("Name")) return TEXT("name");
    if (Type == TEXT("String")) return TEXT("string");
    if (Type == TEXT("Enum")) return TEXT("enum");
    if (Type == TEXT("Float3")) return TEXT("vector3");
    if (Type == TEXT("Float4")) return TEXT("vector4");
    if (Type == TEXT("TextureRef")) return TEXT("texture");
    return TEXT("string");
}

static void SetValueMap(TSharedRef<FJsonObject> ParamMeta, const FString& NodeType, const FString& ParamName, const TSharedPtr<FJsonObject>& ParamObject)
{
    if (ParamName == TEXT("SamplerType"))
    {
        SetValueMapFromPairs(ParamMeta, BuildSamplerTypeMap());
        return;
    }

    if (NodeType == TEXT("Transform") && ParamName == TEXT("Source"))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformSourceMap());
        return;
    }
    if (NodeType == TEXT("Transform") && ParamName == TEXT("Destination"))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformDestinationMap());
        return;
    }
    if (NodeType == TEXT("TransformPosition") && (ParamName == TEXT("Source") || ParamName == TEXT("Destination")))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformPositionMap());
        return;
    }

    const TArray<FString> Values = JsonStringArrayField(ParamObject, TEXT("values"));
    if (Values.Num() == 0)
    {
        return;
    }

    TSharedRef<FJsonObject> ValueMap = MakeShared<FJsonObject>();
    for (const FString& Value : Values)
    {
        ValueMap->SetStringField(Value, Value);
    }
    ParamMeta->SetObjectField(TEXT("valueMap"), ValueMap);
}

static TSharedPtr<FJsonObject> BuildVectorComponents(const FString& NodeType)
{
    TSharedPtr<FJsonObject> Components = MakeShared<FJsonObject>();
    if (NodeType == TEXT("Constant2Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        return Components;
    }
    if (NodeType == TEXT("Constant3Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        Components->SetStringField(TEXT("B"), TEXT("B"));
        return Components;
    }
    if (NodeType == TEXT("Constant4Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        Components->SetStringField(TEXT("B"), TEXT("B"));
        Components->SetStringField(TEXT("A"), TEXT("A"));
        return Components;
    }
    return nullptr;
}

static void AddParamMeta(const FString& NodeType, const FString& ParamName, const TSharedPtr<FJsonObject>& ParamObject, TSharedRef<FJsonObject> ParamsObject)
{
    const FString Type = JsonStringField(ParamObject, TEXT("type"));
    TSharedRef<FJsonObject> ParamMeta = MakeShared<FJsonObject>();

    const TSharedPtr<FJsonObject> VectorComponents = BuildVectorComponents(NodeType);
    if (VectorComponents.IsValid() && ParamName == TEXT("R"))
    {
        ParamMeta->SetStringField(TEXT("property"), TEXT("Constant"));
        if (NodeType == TEXT("Constant2Vector"))
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector2"));
        }
        else if (NodeType == TEXT("Constant3Vector"))
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector3"));
        }
        else
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector4"));
        }
        ParamMeta->SetObjectField(TEXT("components"), VectorComponents.ToSharedRef());
        ParamsObject->SetObjectField(ParamName, ParamMeta);
        return;
    }

    if (VectorComponents.IsValid() && (ParamName == TEXT("G") || ParamName == TEXT("B") || ParamName == TEXT("A")))
    {
        return;
    }

    ParamMeta->SetStringField(TEXT("property"), ResolveParamProperty(NodeType, ParamName));
    ParamMeta->SetStringField(TEXT("kind"), KindForParamType(Type));
    if (Type == TEXT("Enum"))
    {
        SetValueMap(ParamMeta, NodeType, ParamName, ParamObject);
    }
    ParamsObject->SetObjectField(ParamName, ParamMeta);
}

static TSharedRef<FJsonObject> BuildInputsObject(const FString& NodeType, const TArray<FString>& InputNames, UClass* Class, UMaterialExpression* Expression)
{
    TSharedRef<FJsonObject> InputsObject = MakeShared<FJsonObject>();
    for (const FString& PinName : InputNames)
    {
        TSharedRef<FJsonObject> InputMeta = MakeShared<FJsonObject>();
        InputMeta->SetStringField(TEXT("property"), ResolveInputProperty(NodeType, PinName, Class, Expression));
        InputsObject->SetObjectField(PinName, InputMeta);
    }
    return InputsObject;
}

static TSharedRef<FJsonObject> BuildOutputsObject(const TArray<FString>& OutputNames, UMaterialExpression* Expression)
{
    TSharedRef<FJsonObject> OutputsObject = MakeShared<FJsonObject>();
    TArray<FExpressionOutput> EngineOutputs;
    if (Expression != nullptr)
    {
        EngineOutputs = Expression->GetOutputs();
    }

    for (int32 Index = 0; Index < OutputNames.Num(); ++Index)
    {
        TSharedRef<FJsonObject> OutputMeta = MakeShared<FJsonObject>();
        OutputMeta->SetNumberField(TEXT("index"), Index);
        OutputsObject->SetObjectField(OutputNames[Index], OutputMeta);
    }

    return OutputsObject;
}

static TSharedRef<FJsonObject> BuildParamsObject(const FString& NodeType, const TMap<FString, TSharedPtr<FJsonObject>>& ParamObjects)
{
    TSharedRef<FJsonObject> ParamsObject = MakeShared<FJsonObject>();
    for (const TPair<FString, TSharedPtr<FJsonObject>>& Pair : ParamObjects)
    {
        AddParamMeta(NodeType, Pair.Key, Pair.Value, ParamsObject);
    }
    return ParamsObject;
}

static TSharedRef<FJsonObject> BuildFunctionInputsObject(const TArray<FString>& InputNames)
{
    TSharedRef<FJsonObject> InputsObject = MakeShared<FJsonObject>();
    for (int32 Index = 0; Index < InputNames.Num(); ++Index)
    {
        TSharedRef<FJsonObject> InputMeta = MakeShared<FJsonObject>();
        InputMeta->SetStringField(TEXT("property"), FString::Printf(TEXT("FunctionInputs(%d)"), Index));
        InputsObject->SetObjectField(InputNames[Index], InputMeta);
    }
    return InputsObject;
}

static FString ExistingSampleFor(const TSharedPtr<FJsonObject>& ExistingRoot, const FString& NodeType, bool bReserved)
{
    if (!ExistingRoot.IsValid())
    {
        return TEXT("");
    }

    const TSharedPtr<FJsonObject>* Section = nullptr;
    if (!ExistingRoot->TryGetObjectField(bReserved ? TEXT("reserved") : TEXT("nodes"), Section) || Section == nullptr || !Section->IsValid())
    {
        return TEXT("");
    }

    const TSharedPtr<FJsonObject>* Entry = nullptr;
    if (!(*Section)->TryGetObjectField(NodeType, Entry) || Entry == nullptr || !Entry->IsValid())
    {
        return TEXT("");
    }

    return JsonStringField(*Entry, TEXT("sample"));
}

static TSharedRef<FJsonObject> BuildNodeEntry(const FString& NodeType, const TSharedPtr<FJsonObject>& NodeObject, const TSharedPtr<FJsonObject>& ExistingRoot, int32& WarningCount)
{
    const bool bDynamic = DynamicNodeTypes.Contains(NodeType);
    static const TMap<FString, FString> FunctionAssetOverrides = BuildFunctionAssetOverrides();
    const FString* FunctionAsset = FunctionAssetOverrides.Find(NodeType);
    if (FunctionAsset != nullptr)
    {
        UClass* FunctionCallClass = ResolveExpressionClass(TEXT("MaterialFunctionCall"));
        UObject* FunctionObject = LoadObject<UObject>(nullptr, **FunctionAsset);

        TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("ueClass"), TEXT("/Script/Engine.MaterialExpressionMaterialFunctionCall"));
        Entry->SetObjectField(TEXT("inputs"), BuildFunctionInputsObject(ReadNamesFromArray(NodeObject, TEXT("inputs"))));
        Entry->SetObjectField(TEXT("outputs"), BuildOutputsObject(ReadNamesFromArray(NodeObject, TEXT("outputs")), nullptr));
        Entry->SetObjectField(TEXT("params"), BuildParamsObject(NodeType, ReadParamObjects(NodeObject)));
        Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, NodeType, false));
        Entry->SetStringField(TEXT("functionRefProperty"), TEXT("MaterialFunction"));
        Entry->SetStringField(TEXT("functionAsset"), *FunctionAsset);

        if (FunctionCallClass != nullptr && FunctionObject != nullptr)
        {
            Entry->SetBoolField(TEXT("verified"), true);
            Entry->SetStringField(TEXT("note"), TEXT("Verified as a UE built-in Material Function call by commandlet asset loading."));
        }
        else
        {
            Entry->SetBoolField(TEXT("verified"), false);
            Entry->SetStringField(TEXT("note"), TEXT("Built-in Material Function asset or call class was not found by the commandlet."));
            ++WarningCount;
            UE_LOG(LogTemp, Warning, TEXT("Could not resolve built-in function node '%s' at '%s'"), *NodeType, **FunctionAsset);
        }

        return Entry;
    }

    UClass* Class = ResolveExpressionClass(NodeType);
    UMaterialExpression* Expression = Class != nullptr ? Cast<UMaterialExpression>(Class->GetDefaultObject()) : nullptr;

    TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("ueClass"), Class != nullptr ? Class->GetPathName() : FString::Printf(TEXT("/Script/Engine.MaterialExpression%s"), *NodeType));

    if (bDynamic)
    {
        Entry->SetObjectField(TEXT("inputs"), MakeShared<FJsonObject>());
        Entry->SetObjectField(TEXT("outputs"), MakeShared<FJsonObject>());
    }
    else
    {
        Entry->SetObjectField(TEXT("inputs"), BuildInputsObject(NodeType, ReadNamesFromArray(NodeObject, TEXT("inputs")), Class, Expression));
        Entry->SetObjectField(TEXT("outputs"), BuildOutputsObject(ReadNamesFromArray(NodeObject, TEXT("outputs")), Expression));
    }

    Entry->SetObjectField(TEXT("params"), BuildParamsObject(NodeType, ReadParamObjects(NodeObject)));
    Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, NodeType, false));

    if (bDynamic)
    {
        Entry->SetBoolField(TEXT("verified"), false);
        Entry->SetBoolField(TEXT("dynamicExport"), true);
        Entry->SetStringField(TEXT("note"), TEXT("Dynamic-pin node; static export is intentionally skipped unless a per-instance exporter is implemented."));
    }
    else if (Class != nullptr)
    {
        Entry->SetBoolField(TEXT("verified"), true);
        if (NodeType == TEXT("TextureSampleParameterMovie"))
        {
            Entry->SetStringField(TEXT("note"), TEXT("Verified by UE reflection commandlet; UE 5.7 exports movie texture parameters through MaterialExpressionTextureSampleParameter2D."));
        }
        else
        {
            Entry->SetStringField(TEXT("note"), TEXT("Verified by UE reflection commandlet. Raw clipboard T3D sample is preserved only when already present."));
        }
    }
    else
    {
        Entry->SetBoolField(TEXT("verified"), false);
        Entry->SetStringField(TEXT("note"), TEXT("UE class was not found by the reflection commandlet; inspect class mapping before export."));
        ++WarningCount;
        UE_LOG(LogTemp, Warning, TEXT("Could not resolve UE material expression class for node type '%s'"), *NodeType);
    }

    return Entry;
}

static TSharedRef<FJsonObject> MakeReservedEntry(const FString& Type, const FString& ClassPath, const TSharedPtr<FJsonObject>& ExistingRoot)
{
    TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("ueClass"), ClassPath);
    Entry->SetObjectField(TEXT("inputs"), MakeShared<FJsonObject>());
    Entry->SetObjectField(TEXT("outputs"), MakeShared<FJsonObject>());
    Entry->SetObjectField(TEXT("params"), MakeShared<FJsonObject>());
    Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, Type, true));
    Entry->SetBoolField(TEXT("verified"), true);
    Entry->SetStringField(TEXT("note"), TEXT("Reserved exporter metadata maintained by commandlet defaults."));
    return Entry;
}

static TSharedRef<FJsonObject> BuildReservedObject(const TSharedPtr<FJsonObject>& ExistingRoot)
{
    TSharedRef<FJsonObject> Reserved = MakeShared<FJsonObject>();

    TSharedRef<FJsonObject> MaterialFunctionCall = MakeReservedEntry(TEXT("MaterialFunctionCall"), TEXT("/Script/Engine.MaterialExpressionMaterialFunctionCall"), ExistingRoot);
    MaterialFunctionCall->SetStringField(TEXT("functionRefProperty"), TEXT("MaterialFunction"));
    Reserved->SetObjectField(TEXT("MaterialFunctionCall"), MaterialFunctionCall);

    TSharedRef<FJsonObject> FunctionInput = MakeReservedEntry(TEXT("FunctionInput"), TEXT("/Script/Engine.MaterialExpressionFunctionInput"), ExistingRoot);
    TSharedRef<FJsonObject> FunctionInputOutputs = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> InputOutput = MakeShared<FJsonObject>();
    InputOutput->SetNumberField(TEXT("index"), 0);
    FunctionInputOutputs->SetObjectField(TEXT("Input"), InputOutput);
    FunctionInput->SetObjectField(TEXT("outputs"), FunctionInputOutputs);
    TSharedRef<FJsonObject> FunctionInputParams = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> InputName = MakeShared<FJsonObject>();
    InputName->SetStringField(TEXT("property"), TEXT("InputName"));
    InputName->SetStringField(TEXT("kind"), TEXT("name"));
    FunctionInputParams->SetObjectField(TEXT("InputName"), InputName);
    TSharedRef<FJsonObject> InputType = MakeShared<FJsonObject>();
    InputType->SetStringField(TEXT("property"), TEXT("InputType"));
    InputType->SetStringField(TEXT("kind"), TEXT("enum"));
    FunctionInputParams->SetObjectField(TEXT("InputType"), InputType);
    FunctionInput->SetObjectField(TEXT("params"), FunctionInputParams);
    Reserved->SetObjectField(TEXT("FunctionInput"), FunctionInput);

    TSharedRef<FJsonObject> FunctionOutput = MakeReservedEntry(TEXT("FunctionOutput"), TEXT("/Script/Engine.MaterialExpressionFunctionOutput"), ExistingRoot);
    TSharedRef<FJsonObject> FunctionOutputInputs = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> OutputInput = MakeShared<FJsonObject>();
    OutputInput->SetStringField(TEXT("property"), TEXT("A"));
    FunctionOutputInputs->SetObjectField(TEXT("Input"), OutputInput);
    FunctionOutput->SetObjectField(TEXT("inputs"), FunctionOutputInputs);
    TSharedRef<FJsonObject> FunctionOutputParams = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> OutputName = MakeShared<FJsonObject>();
    OutputName->SetStringField(TEXT("property"), TEXT("OutputName"));
    OutputName->SetStringField(TEXT("kind"), TEXT("name"));
    FunctionOutputParams->SetObjectField(TEXT("OutputName"), OutputName);
    FunctionOutput->SetObjectField(TEXT("params"), FunctionOutputParams);
    Reserved->SetObjectField(TEXT("FunctionOutput"), FunctionOutput);

    return Reserved;
}
} // namespace UE::MatExportMetadata

UUEMatExportMetadataCommandlet::UUEMatExportMetadataCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UUEMatExportMetadataCommandlet::Main(const FString& Params)
{
    using namespace UE::MatExportMetadata;

    FString NodeDbPath;
    FString OutPath;
    const bool bHasNodeDb = FParse::Value(*Params, TEXT("NodeDb="), NodeDbPath);
    const bool bHasOut = FParse::Value(*Params, TEXT("Out="), OutPath);
    const bool bStrict = FParse::Param(*Params, TEXT("Strict"));

    if (!bHasNodeDb || !bHasOut)
    {
        UE_LOG(LogTemp, Error, TEXT("Usage: -run=UEMatExportMetadata -NodeDb=<nodes-ue5.7.json> -Out=<nodes-ue5.7.export.json> [-Strict]"));
        return 2;
    }

    NodeDbPath = ToAbsolutePath(NodeDbPath);
    OutPath = ToAbsolutePath(OutPath);

    FString Error;
    TSharedPtr<FJsonObject> DbRoot;
    if (!LoadJsonFile(NodeDbPath, DbRoot, Error))
    {
        UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
        return 3;
    }

    TSharedPtr<FJsonObject> ExistingRoot;
    if (IFileManager::Get().FileExists(*OutPath))
    {
        FString ExistingError;
        LoadJsonFile(OutPath, ExistingRoot, ExistingError);
    }

    const TSharedPtr<FJsonObject>* NodesObject = nullptr;
    if (!DbRoot->TryGetObjectField(TEXT("nodes"), NodesObject) || NodesObject == nullptr || !NodesObject->IsValid())
    {
        UE_LOG(LogTemp, Error, TEXT("Node DB is missing the top-level 'nodes' object: %s"), *NodeDbPath);
        return 4;
    }

    int32 WarningCount = 0;
    TSharedRef<FJsonObject> OutRoot = MakeShared<FJsonObject>();
    OutRoot->SetStringField(TEXT("schemaVersion"), TEXT("1.0"));
    OutRoot->SetStringField(TEXT("ueVersion"), JsonStringField(DbRoot, TEXT("ueVersion"), TEXT("5.7")));
    OutRoot->SetStringField(TEXT("generatedAt"), FDateTime::UtcNow().ToIso8601());
    OutRoot->SetStringField(TEXT("source"), TEXT("Generated by UEMatExportMetadata UE Editor commandlet using UE reflection."));

    TSharedRef<FJsonObject> OutNodes = MakeShared<FJsonObject>();
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*NodesObject)->Values)
    {
        const TSharedPtr<FJsonObject> NodeObject = Pair.Value.IsValid() ? Pair.Value->AsObject() : nullptr;
        if (!NodeObject.IsValid())
        {
            ++WarningCount;
            UE_LOG(LogTemp, Warning, TEXT("Node DB entry is not an object: %s"), *Pair.Key);
            continue;
        }
        OutNodes->SetObjectField(Pair.Key, BuildNodeEntry(Pair.Key, NodeObject, ExistingRoot, WarningCount));
    }
    OutRoot->SetObjectField(TEXT("nodes"), OutNodes);
    OutRoot->SetObjectField(TEXT("reserved"), BuildReservedObject(ExistingRoot));

    FString OutputText;
    const TSharedRef<TJsonWriter<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>::Create(&OutputText);
    if (!FJsonSerializer::Serialize(OutRoot, Writer))
    {
        UE_LOG(LogTemp, Error, TEXT("Failed to serialize export metadata JSON."));
        return 5;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(OutPath), true);
    if (!FFileHelper::SaveStringToFile(OutputText, *OutPath))
    {
        UE_LOG(LogTemp, Error, TEXT("Failed to write export metadata: %s"), *OutPath);
        return 6;
    }

    UE_LOG(LogTemp, Display, TEXT("Wrote UE export metadata: %s"), *OutPath);
    UE_LOG(LogTemp, Display, TEXT("Warnings: %d"), WarningCount);
    return bStrict && WarningCount > 0 ? 7 : 0;
}
